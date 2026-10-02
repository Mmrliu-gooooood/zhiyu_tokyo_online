'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  RotateCcw,
  Plus,
  Zap,
  Settings2,
  Trash2,
  Sparkles,
  Wrench,
  FileText,
  Send,
  Download,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProviderConfig } from '@/lib/types/provider';
import type { ProvidersConfig } from '@/lib/types/settings';
import type { WireApi } from '@/lib/model-gateway/types';
import type { ClientProviderConfig } from '@/lib/model-gateway/catalog/client-catalog';
import { createVerifyModelRequest, formatContextWindow, requestPathForApi } from './utils';
import { cn } from '@/lib/utils';

/** Catalog facts the panel needs about a built-in provider (absent for `custom-*`). */
export type ProviderCatalogInfo = Pick<
  ClientProviderConfig,
  'authMethods' | 'allowCustomBaseUrl' | 'endpointParams'
>;

type AuthTab = 'api-key' | 'oauth';

/** Base URL preview with declared endpoint values substituted when known. */
export function previewEndpoint(baseUrl: string, params: Record<string, string>): string {
  return baseUrl.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (match, name: string) =>
    params[name]?.trim() ? params[name]!.trim() : match,
  );
}

interface ProviderConfigPanelProps {
  provider: ProviderConfig;
  /** Catalog entry of a built-in provider. */
  catalog?: ProviderCatalogInfo;
  /** Explicit wire protocol (custom providers). */
  api?: WireApi;
  /** Whether this deployment offers subscription sign-in for the provider. */
  oauthAvailable?: boolean;
  initialApiKey: string;
  initialBaseUrl: string;
  initialRequiresApiKey: boolean;
  initialEndpointParams?: Record<string, string>;
  providersConfig: ProvidersConfig;
  onConfigChange: (apiKey: string, baseUrl: string, requiresApiKey: boolean) => void;
  onEndpointParamsChange?: (params: Record<string, string>) => void;
  onSave: () => void; // Auto-save on blur
  onEditModel: (index: number) => void;
  onDeleteModel: (index: number) => void;
  onAddModel: () => void;
  /** Merge probed model ids into the provider's list; returns the count added. */
  onModelsFetched?: (ids: string[]) => number;
  /** Optional explicit /models URL override (from a preset). */
  modelsUrl?: string;
  onResetToDefault?: () => void; // Reset provider to default configuration
  isBuiltIn: boolean; // To determine if reset button should be shown
}

export function ProviderConfigPanel({
  provider,
  catalog,
  api,
  oauthAvailable = false,
  initialApiKey,
  initialBaseUrl,
  initialRequiresApiKey,
  initialEndpointParams,
  providersConfig,
  onConfigChange,
  onEndpointParamsChange,
  onSave,
  onEditModel,
  onDeleteModel,
  onAddModel,
  onModelsFetched,
  modelsUrl,
  onResetToDefault,
  isBuiltIn,
}: ProviderConfigPanelProps) {
  const { t } = useI18n();

  // Local state for this provider
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [requiresApiKey, setRequiresApiKey] = useState(initialRequiresApiKey);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'fetching' | 'success' | 'error'>('idle');
  const [fetchMessage, setFetchMessage] = useState('');
  const [endpointParams, setEndpointParams] = useState<Record<string, string>>(
    initialEndpointParams ?? {},
  );
  const [authTab, setAuthTab] = useState<AuthTab>('api-key');
  const fixedEndpoint = catalog?.allowCustomBaseUrl === false;
  const declaredParams = catalog?.endpointParams ?? [];
  const initialParamsKey = JSON.stringify(initialEndpointParams ?? {});

  // Update local state when provider changes or initial values change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync local state from props on provider change
    setApiKey(initialApiKey);

    setBaseUrl(initialBaseUrl);

    setRequiresApiKey(initialRequiresApiKey);

    setTestStatus('idle');

    setTestMessage('');
    setFetchStatus('idle');
    setFetchMessage('');
    setEndpointParams(JSON.parse(initialParamsKey) as Record<string, string>);
    setAuthTab('api-key');
  }, [provider.id, initialApiKey, initialBaseUrl, initialRequiresApiKey, initialParamsKey]);

  // Notify parent of changes
  const handleApiKeyChange = (key: string) => {
    setApiKey(key);
    onConfigChange(key, baseUrl, requiresApiKey);
  };

  const handleBaseUrlChange = (url: string) => {
    setBaseUrl(url);
    onConfigChange(apiKey, url, requiresApiKey);
  };

  const handleRequiresApiKeyChange = (requires: boolean) => {
    setRequiresApiKey(requires);
    onConfigChange(apiKey, baseUrl, requires);
  };

  const handleEndpointParamChange = (name: string, value: string) => {
    const next = { ...endpointParams, [name]: value };
    setEndpointParams(next);
    onEndpointParamsChange?.(next);
  };

  const handleTestApi = useCallback(async () => {
    setTestStatus('testing');
    setTestMessage('');

    const availableModels = providersConfig[provider.id]?.models || [];

    if (availableModels.length === 0) {
      setTestStatus('error');
      setTestMessage(t('settings.noModelsAvailable') || 'No models available for testing');
      return;
    }

    const testModelId = availableModels[0].id;

    try {
      const response = await fetch('/api/verify-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-model-source': 'user' },
        body: JSON.stringify(
          createVerifyModelRequest({
            providerId: provider.id,
            modelId: testModelId,
            apiKey,
            baseUrl,
            providerType: provider.type,
            requiresApiKey,
            api,
            endpointParams,
          }),
        ),
      });

      const data = await response.json();

      if (data.success) {
        setTestStatus('success');
        setTestMessage(t('settings.connectionSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(data.error || t('settings.connectionFailed'));
      }
    } catch (_error) {
      setTestStatus('error');
      setTestMessage(t('settings.connectionFailed'));
    }
  }, [
    apiKey,
    baseUrl,
    provider.id,
    provider.type,
    requiresApiKey,
    providersConfig,
    api,
    endpointParams,
    t,
  ]);

  const effectiveBaseUrl = baseUrl || provider.defaultBaseUrl || '';

  // Probe the provider's /models endpoint and merge results into the model list.
  const handleFetchModels = useCallback(async () => {
    setFetchStatus('fetching');
    setFetchMessage('');
    try {
      const response = await fetch('/api/provider/probe-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-model-source': 'user' },
        // The provider id lets the server answer from the catalog when its
        // endpoint is the catalog's own (fixed-endpoint providers send none).
        body: JSON.stringify({
          providerId: provider.id,
          baseUrl: fixedEndpoint ? undefined : effectiveBaseUrl,
          apiKey,
          modelsUrl,
        }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        const ids: string[] = (data.models || []).map((m: { id: string }) => m.id);
        const added = onModelsFetched?.(ids) ?? 0;
        setFetchStatus('success');
        setFetchMessage(
          t('settings.fetchModelsResult')
            .replace('{added}', String(added))
            .replace('{total}', String(ids.length)),
        );
      } else if (response.status === 404) {
        setFetchStatus('error');
        setFetchMessage(t('settings.fetchModelsNoEndpoint'));
      } else if (response.status === 401) {
        setFetchStatus('error');
        setFetchMessage(t('settings.fetchModelsAuthError'));
      } else {
        setFetchStatus('error');
        setFetchMessage(data.error || t('settings.fetchModelsFailed'));
      }
    } catch {
      setFetchStatus('error');
      setFetchMessage(t('settings.fetchModelsFailed'));
    }
  }, [apiKey, effectiveBaseUrl, fixedEndpoint, modelsUrl, onModelsFetched, provider.id, t]);

  const models = providersConfig[provider.id]?.models || [];
  const isServerConfigured = providersConfig[provider.id]?.isServerConfigured;
  // When the operator pins an allowed model list (MODELS env/yaml), the model
  // catalog is admin-managed too — view-only, no add/edit/delete. Without a
  // pinned list the server manages only credentials and the user curates models.
  const modelsLocked = !!providersConfig[provider.id]?.serverModels?.length;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* Managed providers are admin-owned: the operator's key and base URL are
          authoritative and not overridable here, so the editing inputs are hidden. */}
      {/* Authentication method tabs: subscription sign-in appears only where
          this deployment enables it (R1: nowhere). */}
      {!isServerConfigured && oauthAvailable && (
        <div role="tablist" className="inline-flex rounded-lg border p-0.5 gap-0.5">
          {(['api-key', 'oauth'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={authTab === tab}
              onClick={() => setAuthTab(tab)}
              className={cn(
                'px-3 py-1 text-sm rounded-md transition-colors',
                authTab === tab
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {t(tab === 'api-key' ? 'settings.authTabApiKey' : 'settings.authTabOAuth')}
            </button>
          ))}
        </div>
      )}
      {!isServerConfigured && oauthAvailable && authTab === 'oauth' && (
        <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          {t('settings.oauthSignInPending')}
        </div>
      )}

      {!isServerConfigured && authTab === 'api-key' && (
        <>
          {/* API Key */}
          <div className="space-y-2">
            <Label>{t('settings.apiSecret')}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  name={`llm-api-key-${provider.id}`}
                  type={showApiKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => handleApiKeyChange(e.target.value)}
                  onBlur={onSave}
                  disabled={!requiresApiKey}
                  className="h-8 pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  disabled={!requiresApiKey}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestApi}
                disabled={testStatus === 'testing' || (requiresApiKey && !apiKey)}
                className="gap-1.5"
              >
                {testStatus === 'testing' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Zap className="h-3.5 w-3.5" />
                    {t('settings.testConnection')}
                  </>
                )}
              </Button>
            </div>
            {testMessage && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm overflow-hidden',
                  testStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
                  testStatus === 'error' && 'bg-red-50 text-red-700 border border-red-200',
                )}
              >
                <div className="flex items-start gap-2 min-w-0">
                  {testStatus === 'success' && <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />}
                  {testStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  <p className="flex-1 min-w-0 break-all">{testMessage}</p>
                </div>
              </div>
            )}
            <div className="flex items-center space-x-2">
              <Checkbox
                id={`requires-api-key-${provider.id}`}
                checked={requiresApiKey}
                onCheckedChange={(checked) => {
                  handleRequiresApiKeyChange(checked as boolean);
                  onSave();
                }}
              />
              <label
                htmlFor={`requires-api-key-${provider.id}`}
                className="text-sm cursor-pointer text-muted-foreground"
              >
                {t('settings.requiresApiKey')}
              </label>
            </div>
          </div>

          {/* API Host */}
          {fixedEndpoint ? (
            <div className="space-y-2">
              <Label>{t('settings.apiHost')}</Label>
              {provider.defaultBaseUrl && (
                <p className="text-xs text-muted-foreground break-all">
                  {t('settings.requestUrl')}:{' '}
                  {previewEndpoint(provider.defaultBaseUrl, endpointParams) +
                    requestPathForApi(api, provider.type)}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{t('settings.fixedEndpointHint')}</p>
              {baseUrl && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                  <span className="break-all">
                    {t('settings.customBaseUrlNotAllowed').replace('{url}', baseUrl)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0"
                    onClick={() => {
                      handleBaseUrlChange('');
                      onSave();
                    }}
                  >
                    {t('settings.clearCustomBaseUrl')}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Label>{t('settings.apiHost')}</Label>
              <Input
                name={`llm-base-url-${provider.id}`}
                type="url"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={
                  provider.baseUrlPlaceholder ||
                  provider.defaultBaseUrl ||
                  'https://api.example.com/v1'
                }
                value={baseUrl}
                onChange={(e) => handleBaseUrlChange(e.target.value)}
                onBlur={onSave}
                className="h-8"
              />
              {provider.alternateBaseUrls && provider.alternateBaseUrls.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {provider.alternateBaseUrls.map((alt) => {
                    const active = (baseUrl || provider.defaultBaseUrl) === alt.url;
                    return (
                      <button
                        key={alt.url}
                        type="button"
                        onClick={() => {
                          handleBaseUrlChange(alt.url);
                          onSave();
                        }}
                        className={cn(
                          'px-2 py-0.5 text-xs rounded-md border transition-colors',
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background text-muted-foreground border-border hover:bg-muted',
                        )}
                      >
                        {t(alt.label)}
                      </button>
                    );
                  })}
                </div>
              )}
              {effectiveBaseUrl && (
                <p className="text-xs text-muted-foreground break-all">
                  {t('settings.requestUrl')}:{' '}
                  {effectiveBaseUrl + requestPathForApi(api, provider.type)}
                </p>
              )}
            </div>
          )}

          {/* Non-secret endpoint values the catalog endpoint needs */}
          {declaredParams.map((name) => (
            <div key={name} className="space-y-2">
              <Label htmlFor={`llm-endpoint-${provider.id}-${name}`}>
                {t(`settings.endpointParamLabels.${name}`)}
              </Label>
              <Input
                id={`llm-endpoint-${provider.id}-${name}`}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={endpointParams[name] ?? ''}
                onChange={(e) => handleEndpointParamChange(name, e.target.value)}
                onBlur={onSave}
                className="h-8"
              />
            </div>
          ))}
        </>
      )}

      {/* Models - No selection state, just list for management */}
      <div className="space-y-3">
        {provider.id === 'azure' && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
            {t('settings.azureDeploymentHint')}
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Label className="text-base">{t('settings.models')}</Label>
            {modelsLocked && (
              <span className="text-[10px] px-1 py-0 h-4 leading-4 rounded bg-muted text-muted-foreground">
                {t('settings.serverConfigured')}
              </span>
            )}
          </div>
          {!modelsLocked && (
            <div className="flex items-center gap-2 flex-wrap">
              {isBuiltIn && onResetToDefault && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowResetDialog(true)}
                  className="gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('settings.reset')}
                </Button>
              )}
              {provider.supportsModelDiscovery !== false && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleFetchModels}
                  disabled={fetchStatus === 'fetching' || (requiresApiKey && !apiKey)}
                  className="gap-1.5"
                >
                  {fetchStatus === 'fetching' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {t('settings.fetchModels')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={onAddModel} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                {t('settings.addNewModel')}
              </Button>
            </div>
          )}
        </div>

        {/* Fetch-models result message */}
        {fetchMessage && (
          <div
            className={cn(
              'rounded-lg p-2.5 text-xs',
              fetchStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
              fetchStatus === 'error' && 'bg-amber-50 text-amber-700 border border-amber-200',
            )}
          >
            {fetchMessage}
          </div>
        )}

        <div className="space-y-1.5">
          {models.map((model, index) => {
            return (
              <div
                key={model.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card"
              >
                <div className="flex-1">
                  <div className="font-mono text-sm font-medium mb-1.5">{model.name}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {/* Capabilities */}
                    <div className="flex items-center gap-1">
                      {model.capabilities?.vision && (
                        <div title={t('settings.capabilities.vision')}>
                          <Sparkles className="h-3 w-3" />
                        </div>
                      )}
                      {model.capabilities?.tools && (
                        <div title={t('settings.capabilities.tools')}>
                          <Wrench className="h-3 w-3" />
                        </div>
                      )}
                      {model.capabilities?.streaming && (
                        <div title={t('settings.capabilities.streaming')}>
                          <Zap className="h-3 w-3" />
                        </div>
                      )}
                    </div>
                    {/* Context Window */}
                    {model.contextWindow && (
                      <span className="flex items-center gap-0.5">
                        <FileText className="h-3 w-3" />
                        <span className="text-[10px]">
                          {formatContextWindow(model.contextWindow)}
                        </span>
                      </span>
                    )}
                    {/* Output Window */}
                    {model.outputWindow && (
                      <span className="flex items-center gap-0.5">
                        <Send className="h-3 w-3" />
                        <span className="text-[10px]">
                          {formatContextWindow(model.outputWindow)}
                        </span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Edit/Delete Buttons — hidden when the model catalog is server-managed */}
                {!modelsLocked && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2"
                      onClick={() => onEditModel(index)}
                      title={t('settings.editModel')}
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => onDeleteModel(index)}
                      title={t('settings.deleteModel')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Reset Confirmation Dialog */}
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.resetToDefault')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.resetConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowResetDialog(false);
                onResetToDefault?.();
              }}
            >
              {t('settings.confirmReset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
