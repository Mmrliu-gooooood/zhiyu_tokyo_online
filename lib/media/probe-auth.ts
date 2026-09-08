type ConnectivityResult = {
  success: boolean;
  message: string;
};

interface ProbeAuthOptions {
  providerName: string;
  request: () => Promise<Response>;
  /** Provider-defined validation/not-found responses that prove auth was accepted. */
  acceptedStatuses?: readonly number[];
}

async function responseDetail(response: Response): Promise<string> {
  const text = (await response.text()).replace(/\s+/g, ' ').trim();
  return text.slice(0, 500) || response.statusText || 'request failed';
}

export async function probeAuth({
  providerName,
  request,
  acceptedStatuses = [],
}: ProbeAuthOptions): Promise<ConnectivityResult> {
  try {
    const response = await request();
    if (response.status >= 300 && response.status < 400) {
      return {
        success: false,
        message: `${providerName} connectivity error: Redirects are not allowed`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      const text = await responseDetail(response);
      return {
        success: false,
        message: `${providerName} auth failed (${response.status}): ${text}`,
      };
    }
    if (response.ok || acceptedStatuses.includes(response.status)) {
      return { success: true, message: `Connected to ${providerName}` };
    }
    if (response.status === 429 || response.status >= 400) {
      const text = await responseDetail(response);
      return {
        success: false,
        message: `${providerName} connectivity failed (${response.status}): ${text}`,
      };
    }
    return {
      success: false,
      message: `${providerName} connectivity failed (${response.status}): ${response.statusText || 'request failed'}`,
    };
  } catch (err) {
    return { success: false, message: `${providerName} connectivity error: ${err}` };
  }
}
