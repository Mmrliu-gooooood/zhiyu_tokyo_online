import {
  BrowserKVStore,
  HttpAssetStore,
  HttpDocumentStore,
  type HttpAssetHeadersHook,
  type HttpDocumentHeadersHook,
} from '@openmaic/storage';
import { HttpRuntimeStore, type HttpRuntimeHeadersHook } from '@openmaic/storage/runtime/http';

import {
  assertDocumentStorageConfigurable,
  configureDocumentStorage,
  type DocumentStorageOptions,
} from '@/lib/document-store/config';
import {
  assertAssetPoolStorageConfigurable,
  configureAssetPoolStorage,
  type AssetPoolStorageOptions,
} from '@/lib/media/asset-pool-config';
import { createBrowserAssetPoolStore } from '@/lib/media/browser-asset-store-factory';
import { assertRuntimeStorageConfigurable, configureRuntimeStorage } from '@/lib/runtime/config';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import {
  canUseHostedAuthUi,
  isHostedAuthEnabled,
  SESSION_ID_HEADER,
  USER_ID_HEADER,
} from '@/lib/auth/mode';
import { ServerAssetStoreWithLegacyFallback } from './server-asset-store-with-legacy-fallback';

let deviceKv: BrowserKVStore | undefined;
let learnerKeyPromise: Promise<string> | undefined;

export function isBrowserPersistenceEnabled(): boolean {
  return typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1';
}

export function getPersistenceLearnerKey(): Promise<string> {
  if (!isBrowserPersistenceEnabled()) {
    return Promise.reject(new Error('Browser persistence is not enabled'));
  }
  if (canUseHostedAuthUi()) {
    return import('@/lib/auth/account-environment').then(({ requireAccountEnvironment }) =>
      requireAccountEnvironment()
        .then((account) => account.learnerKey)
        .catch((error) => {
          if (isHostedAuthEnabled()) throw error;
          return (learnerKeyPromise ??= getLearnerKey((deviceKv ??= new BrowserKVStore())).catch(
            (deviceError) => {
              learnerKeyPromise = undefined;
              throw deviceError;
            },
          ));
        }),
    );
  }
  return (learnerKeyPromise ??= getLearnerKey((deviceKv ??= new BrowserKVStore())).catch(
    (error) => {
      learnerKeyPromise = undefined;
      throw error;
    },
  ));
}

export async function getPersistenceRequestHeaders(): Promise<Record<string, string>> {
  if (!isBrowserPersistenceEnabled()) return {};
  if (canUseHostedAuthUi()) {
    try {
      const { requireAccountEnvironment } = await import('@/lib/auth/account-environment');
      const account = await requireAccountEnvironment();
      return {
        'x-learner-key': account.learnerKey,
        [USER_ID_HEADER]: account.userId,
        [SESSION_ID_HEADER]: account.sessionId,
      };
    } catch (error) {
      if (isHostedAuthEnabled()) throw error;
    }
  }
  const resolvedLearnerKey = await getPersistenceLearnerKey();
  const token = process.env.NEXT_PUBLIC_PERSISTENCE_TOKEN;
  return {
    'x-learner-key': resolvedLearnerKey,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

if (isBrowserPersistenceEnabled()) {
  const learnerKey = getPersistenceLearnerKey;
  const headers = getPersistenceRequestHeaders;

  const runtimeOptions = {
    store: () =>
      new HttpRuntimeStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpRuntimeHeadersHook,
      }),
    learnerKey,
  };
  const documentOptions: DocumentStorageOptions = {
    store: ({ validateScene, validateStage }) =>
      new HttpDocumentStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpDocumentHeadersHook,
        validateScene,
        validateStage,
      }),
  };
  const assetOptions: AssetPoolStorageOptions = {
    store: () => {
      const http = new HttpAssetStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpAssetHeadersHook,
      });
      if (isHostedAuthEnabled()) return http;
      return new ServerAssetStoreWithLegacyFallback(http, createBrowserAssetPoolStore());
    },
    serverBacked: true,
  };
  try {
    // All checks are mutation-free. Once they pass, the synchronous configure
    // calls cannot leave only a subset of the persistence seams configured.
    assertRuntimeStorageConfigurable();
    assertDocumentStorageConfigurable();
    assertAssetPoolStorageConfigurable();
    configureRuntimeStorage(runtimeOptions);
    configureDocumentStorage(documentOptions);
    configureAssetPoolStorage(assetOptions);
  } catch (error) {
    console.error(
      'FATAL: server-backed persistence bootstrap failed; no storage seam changes were applied',
      error,
    );
  }
}
