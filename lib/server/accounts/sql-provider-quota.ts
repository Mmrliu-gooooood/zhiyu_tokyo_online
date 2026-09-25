/** v19: hosted request callers share provider quota without reading worker lease rows. */
export const ACCOUNTS_RLS_SQL_V19 = `
ALTER TABLE public.generation_provider_slots ADD COLUMN IF NOT EXISTS holder_owner_id text;

CREATE OR REPLACE FUNCTION app_internal.assert_provider_quota_owner(p_group text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $quota_owner$
DECLARE v_owner text := app_internal.current_owner_id();
BEGIN
  IF v_owner IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.app_accounts account
     WHERE account.owner_id=v_owner AND account.status='active'
  ) THEN
    RAISE EXCEPTION 'active owner required' USING ERRCODE='42501';
  END IF;
  IF p_group IS NULL OR length(p_group)>200 OR p_group !~ '^(llm|tts|media):[A-Za-z0-9:_-]+$' THEN
    RAISE EXCEPTION 'invalid provider quota group' USING ERRCODE='22023';
  END IF;
  RETURN v_owner;
END
$quota_owner$;

CREATE OR REPLACE FUNCTION app_internal.acquire_provider_quota(
  p_group text, p_limit integer, p_holder uuid, p_deadline_ms integer
)
RETURNS TABLE(slot_no integer, lease_epoch bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app_internal
AS $quota_acquire$
DECLARE owner_id text := app_internal.assert_provider_quota_owner(p_group);
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_holder IS NULL
     OR p_deadline_ms IS NULL OR p_deadline_ms<1 OR p_deadline_ms>600000 THEN
    RAISE EXCEPTION 'invalid provider lease' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('generation:quota:' || p_group));
  INSERT INTO public.generation_provider_slots(quota_group,slot_no)
    SELECT p_group,value FROM generate_series(0,p_limit-1) value ON CONFLICT DO NOTHING;
  RETURN QUERY
  WITH available AS (
    SELECT reservation.slot_no FROM public.generation_provider_slots reservation
     WHERE reservation.quota_group=p_group AND reservation.slot_no<p_limit
       AND (reservation.holder_attempt_id IS NULL OR
            (reservation.expires_at<=clock_timestamp() AND reservation.quarantine_until<=clock_timestamp()))
       AND (reservation.quarantine_until IS NULL OR reservation.quarantine_until<=clock_timestamp())
       AND (reservation.cooldown_until IS NULL OR reservation.cooldown_until<=clock_timestamp())
     ORDER BY reservation.slot_no LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.generation_provider_slots reservation
     SET holder_attempt_id=p_holder,holder_owner_id=owner_id,
         lease_epoch=reservation.lease_epoch+1,
         expires_at=clock_timestamp()+p_deadline_ms*interval '1 millisecond',
         quarantine_until=clock_timestamp()+(p_deadline_ms+30000)*interval '1 millisecond'
    FROM available
   WHERE reservation.quota_group=p_group AND reservation.slot_no=available.slot_no
  RETURNING reservation.slot_no,reservation.lease_epoch;
END
$quota_acquire$;

CREATE OR REPLACE FUNCTION app_internal.heartbeat_provider_quota(
  p_group text,p_slot integer,p_holder uuid,p_epoch bigint,p_deadline_ms integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $quota_heartbeat$
DECLARE owner_id text := app_internal.assert_provider_quota_owner(p_group); changed integer;
BEGIN
  IF p_deadline_ms IS NULL OR p_deadline_ms<1 OR p_deadline_ms>600000 THEN
    RAISE EXCEPTION 'invalid provider deadline' USING ERRCODE='22023';
  END IF;
  UPDATE public.generation_provider_slots reservation
     SET expires_at=clock_timestamp()+p_deadline_ms*interval '1 millisecond',
         quarantine_until=GREATEST(reservation.quarantine_until,clock_timestamp()+(p_deadline_ms+30000)*interval '1 millisecond')
   WHERE reservation.quota_group=p_group AND reservation.slot_no=p_slot
     AND reservation.holder_attempt_id=p_holder AND reservation.lease_epoch=p_epoch
     AND reservation.holder_owner_id=owner_id AND reservation.expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END
$quota_heartbeat$;

CREATE OR REPLACE FUNCTION app_internal.release_provider_quota(
  p_group text,p_slot integer,p_holder uuid,p_epoch bigint,p_uncertain boolean
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $quota_release$
DECLARE owner_id text := app_internal.assert_provider_quota_owner(p_group); changed integer;
BEGIN
  UPDATE public.generation_provider_slots reservation
     SET holder_attempt_id=NULL,holder_owner_id=NULL,expires_at=NULL,
         quarantine_until=CASE WHEN p_uncertain IS NOT FALSE THEN reservation.quarantine_until ELSE NULL END
   WHERE reservation.quota_group=p_group AND reservation.slot_no=p_slot
     AND reservation.holder_attempt_id=p_holder AND reservation.lease_epoch=p_epoch
     AND reservation.holder_owner_id=owner_id;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END
$quota_release$;

CREATE OR REPLACE FUNCTION app_internal.cooldown_provider_quota(
  p_group text,p_slot integer,p_holder uuid,p_epoch bigint,p_retry_ms integer
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_internal
AS $quota_cooldown$
DECLARE owner_id text := app_internal.assert_provider_quota_owner(p_group);
BEGIN
  IF p_retry_ms IS NULL OR p_retry_ms<0 OR p_retry_ms>3600000 THEN
    RAISE EXCEPTION 'invalid provider cooldown' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('generation:quota:' || p_group));
  PERFORM 1 FROM public.generation_provider_slots reservation
   WHERE reservation.quota_group=p_group AND reservation.slot_no=p_slot
     AND reservation.holder_attempt_id=p_holder AND reservation.lease_epoch=p_epoch
     AND reservation.holder_owner_id=owner_id AND reservation.expires_at>clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.generation_provider_slots reservation
     SET cooldown_until=GREATEST(COALESCE(reservation.cooldown_until,clock_timestamp()),clock_timestamp()+p_retry_ms*interval '1 millisecond')
   WHERE reservation.quota_group=p_group;
  RETURN true;
END
$quota_cooldown$;

REVOKE ALL ON FUNCTION app_internal.assert_provider_quota_owner(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION app_internal.acquire_provider_quota(text,integer,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION app_internal.heartbeat_provider_quota(text,integer,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION app_internal.release_provider_quota(text,integer,uuid,bigint,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION app_internal.cooldown_provider_quota(text,integer,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_internal.acquire_provider_quota(text,integer,uuid,integer) TO app_web;
GRANT EXECUTE ON FUNCTION app_internal.heartbeat_provider_quota(text,integer,uuid,bigint,integer) TO app_web;
GRANT EXECUTE ON FUNCTION app_internal.release_provider_quota(text,integer,uuid,bigint,boolean) TO app_web;
GRANT EXECUTE ON FUNCTION app_internal.cooldown_provider_quota(text,integer,uuid,bigint,integer) TO app_web;
`;
