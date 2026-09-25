/**
 * Server-only S3 client configuration shared by the asset and material byte
 * stores. Application-specific values take precedence; when they are absent
 * the AWS SDK keeps its normal region, endpoint and credential provider
 * chains, preserving existing AWS deployments.
 */

export interface S3ClientConfigValues {
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

type S3Environment = Readonly<Record<string, string | undefined>>;

const S3_RESERVED_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'];
const S3_RESERVED_SUFFIXES = ['-s3alias', '--ol-s3', '.mrap', '--x-s3', '--table-s3'];

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function configuredEndpoint(value: string | undefined): string | undefined {
  const endpoint = optionalValue(value);
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid ASSET_S3_ENDPOINT: expected an absolute HTTP(S) URL');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) {
    throw new Error('Invalid ASSET_S3_ENDPOINT: expected an absolute HTTP(S) URL');
  }
  return endpoint.replace(/\/+$/, '');
}

function configuredBoolean(value: string | undefined): boolean | undefined {
  const normalized = optionalValue(value)?.toLowerCase();
  if (normalized === undefined) return undefined;
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error('Invalid ASSET_S3_FORCE_PATH_STYLE: expected true, false, 1, or 0');
}

/** Validate a configured general-purpose S3 bucket without contacting it. */
export function configuredS3Bucket(
  value: string | undefined,
  variableName = 'ASSET_S3_BUCKET',
): string | undefined {
  const bucket = optionalValue(value);
  if (!bucket) return undefined;
  const invalid =
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) ||
    bucket.includes('..') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket) ||
    S3_RESERVED_PREFIXES.some((prefix) => bucket.startsWith(prefix)) ||
    S3_RESERVED_SUFFIXES.some((suffix) => bucket.endsWith(suffix));
  if (invalid) {
    throw new Error(
      `Invalid ${variableName}: expected a valid Amazon S3 general purpose bucket name`,
    );
  }
  return bucket;
}

/**
 * Resolve only the application-specific overrides. An empty object is
 * intentional: `new S3Client({})` activates the standard AWS configuration
 * and credential chains, so old AWS_REGION/AWS_* credential deployments keep
 * working without copying generic AWS secrets into application code.
 */
export function configuredAssetS3Client(
  environment: S3Environment = process.env,
): S3ClientConfigValues {
  const endpoint = configuredEndpoint(environment.ASSET_S3_ENDPOINT);
  const region = optionalValue(environment.ASSET_S3_REGION);
  const accessKeyId = optionalValue(environment.ASSET_S3_ACCESS_KEY_ID);
  const secretAccessKey = optionalValue(environment.ASSET_S3_SECRET_ACCESS_KEY);

  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      'Invalid asset S3 credentials: ASSET_S3_ACCESS_KEY_ID and ' +
        'ASSET_S3_SECRET_ACCESS_KEY must be configured together',
    );
  }

  const explicitPathStyle = configuredBoolean(environment.ASSET_S3_FORCE_PATH_STYLE);
  return {
    ...(region === undefined ? {} : { region }),
    ...(endpoint === undefined ? {} : { endpoint }),
    // Supabase's S3 endpoint requires path-style requests. Default a custom
    // endpoint to that safe compatibility mode, while permitting an explicit
    // false for another S3-compatible provider.
    ...(explicitPathStyle === undefined && endpoint === undefined
      ? {}
      : { forcePathStyle: explicitPathStyle ?? true }),
    ...(accessKeyId === undefined || secretAccessKey === undefined
      ? {}
      : { credentials: { accessKeyId, secretAccessKey } }),
  };
}
