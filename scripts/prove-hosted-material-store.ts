/**
 * Independent hosted stack material-storage smoke proof. Uploads one tiny
 * owner material through HTTP, verifies its row + local bytes, then removes
 * that exact fixture. Never prints credentials or tokens.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { loadHostedOperatorEnv } from './lib/hosted-operator-env';

const PROJECT_REF = 'lzomhnjyymalupgvcato';
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const ORIGIN = 'http://localhost:3001';
const HOSTED_UI = 'openmaic-hosted-ui';

function sessionCookie(session: object): string {
  const encoded = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  const name = `sb-${PROJECT_REF}-auth-token`;
  if (encoded.length <= 3180) return `${name}=${encoded}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < encoded.length; i += 3180, n += 1) {
    parts.push(`${name}.${n}=${encoded.slice(i, i + 3180)}`);
  }
  return parts.join('; ');
}

function dockerGrant(email: string, password: string, apiKey: string) {
  const payload = JSON.stringify({ email, password, apiKey, url: PROJECT_URL });
  const js =
    "const fs=require('fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fetch(p.url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:p.apiKey,'Content-Type':'application/json'},body:JSON.stringify({email:p.email,password:p.password})}).then(async r=>process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}))).catch(()=>process.exit(1));";
  const raw = execFileSync('docker', ['exec', '-i', HOSTED_UI, 'node', '-e', js], {
    encoding: 'utf8',
    input: payload,
    timeout: 30_000,
  });
  const result = JSON.parse(raw) as { status: number; body: string };
  if (result.status !== 200) throw new Error(`password-grant-failed:${result.status}`);
  return JSON.parse(result.body) as { user: { id: string }; access_token: string };
}

function inspectOrCleanup(ownerId: string, materialId: string, cleanup: boolean): string {
  const input = JSON.stringify({ ownerId, materialId, cleanup });
  const js = String.raw`const fs=require('fs');const path=require('path');const{Pool}=require('pg');const i=JSON.parse(fs.readFileSync(0,'utf8'));const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:15000});(async()=>{const c=await p.connect();let key='';try{await c.query('BEGIN');await c.query("SELECT set_config('app.owner_id',$1,true)",[i.ownerId]);const r=await c.query('SELECT oss_key FROM owner_material WHERE id=$1 AND owner_id=$2',[i.materialId,i.ownerId]);key=String(r.rows[0]?.oss_key||'');if(i.cleanup)await c.query('DELETE FROM owner_material WHERE id=$1 AND owner_id=$2',[i.materialId,i.ownerId]);await c.query('COMMIT');const safe=key.startsWith('materials/'+i.ownerId+'/');const file=safe?path.resolve('/app/data',key):'';const bytes=file&&fs.existsSync(file)?fs.statSync(file).size:0;if(i.cleanup&&file)fs.rmSync(file,{force:true});process.stdout.write(JSON.stringify({row:r.rowCount===1,bytes,safe}));}finally{c.release();await p.end();}})().catch(e=>{process.stderr.write(String(e.message||e));process.exit(1)});`;
  return execFileSync('docker', ['exec', '-i', HOSTED_UI, 'node', '-e', js], {
    encoding: 'utf8',
    input,
    timeout: 45_000,
  });
}

async function main() {
  loadHostedOperatorEnv();
  const email = process.env.TEST_USER_A_EMAIL?.trim();
  const password = process.env.TEST_USER_A_PASSWORD?.trim();
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!email || !password || !apiKey) throw new Error('missing hosted material proof credentials');
  const session = dockerGrant(email, password, apiKey);
  const ownerId = `user:${session.user.id}`;
  const body = Buffer.from(`hosted-material-proof:${randomUUID()}`, 'utf8');
  let materialId = '';
  try {
    const response = await fetch(`${ORIGIN}/api/materials`, {
      method: 'POST',
      headers: {
        cookie: sessionCookie(session),
        origin: ORIGIN,
        'content-type': 'text/plain',
        'content-length': String(body.byteLength),
        'x-material-filename': 'hosted-material-proof.txt',
      },
      body,
    });
    const result = (await response.json()) as { materialId?: string; errorCode?: string };
    materialId = result.materialId ?? '';
    const stored = materialId
      ? (JSON.parse(inspectOrCleanup(ownerId, materialId, false)) as {
          row: boolean;
          bytes: number;
          safe: boolean;
        })
      : { row: false, bytes: 0, safe: false };
    const ok = response.status === 201 && stored.row && stored.safe && stored.bytes === body.byteLength;
    console.info(
      JSON.stringify({
        ok,
        proof: 'hosted-material-store',
        upload: response.status,
        errorCode: result.errorCode,
        row: stored.row,
        bytes: stored.bytes,
      }),
    );
    if (!ok) process.exitCode = 1;
  } finally {
    if (materialId) inspectOrCleanup(ownerId, materialId, true);
  }
}

void main();
