import {AppError} from '../domain/errors.js';
import type {
  AccountStatus,
  AccountUsageDTO,
  CodexAccountClient,
  CodexRuntimeInfo,
  JsonRpcTransport,
  LoginPrompt,
  RateLimitsDTO
} from '../domain/types.js';
import {
  parseAccountResponse,
  parseInitializeResponse,
  parseLoginCompletedNotification,
  parseLoginStartResponse,
  parseRateLimitsResponse,
  parseUsageResponse
} from './parsers.js';

export class AppServerAccountClient implements CodexAccountClient {
  private readonly transport: JsonRpcTransport;
  private readonly applicationVersion: string;
  private initialized = false;
  private runtimeInfo: CodexRuntimeInfo | undefined;

  constructor(transport: JsonRpcTransport, applicationVersion: string) {
    this.transport = transport;
    this.applicationVersion = applicationVersion;
  }

  async initialize(signal?: AbortSignal): Promise<CodexRuntimeInfo> {
    if (this.initialized && this.runtimeInfo !== undefined) {
      return this.runtimeInfo;
    }
    await this.transport.connect(signal);
    const response = await this.transport.request<unknown>(
      'initialize',
      {
        clientInfo: {
          name: 'my_codex_usage',
          title: 'My Codex Usage',
          version: this.applicationVersion
        }
      },
      signal
    );
    const runtimeInfo = parseInitializeResponse(response);
    await this.transport.notify('initialized');
    this.runtimeInfo = runtimeInfo;
    this.initialized = true;
    return runtimeInfo;
  }

  async readAccount(signal?: AbortSignal): Promise<AccountStatus> {
    this.requireInitialized();
    const response = await this.transport.request<unknown>(
      'account/read',
      {refreshToken: false},
      signal
    );
    return parseAccountResponse(response);
  }

  async readRateLimits(signal?: AbortSignal): Promise<RateLimitsDTO> {
    this.requireInitialized();
    return parseRateLimitsResponse(
      await this.transport.request<unknown>(
        'account/rateLimits/read',
        undefined,
        signal
      )
    );
  }

  async readUsage(signal?: AbortSignal): Promise<AccountUsageDTO> {
    this.requireInitialized();
    return parseUsageResponse(
      await this.transport.request<unknown>(
        'account/usage/read',
        undefined,
        signal
      )
    );
  }

  async startChatGPTLogin(signal?: AbortSignal): Promise<LoginPrompt> {
    this.requireInitialized();
    return parseLoginStartResponse(
      await this.transport.request<unknown>(
        'account/login/start',
        {type: 'chatgpt'},
        signal
      )
    );
  }

  async waitForLoginCompletion(
    loginId: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.requireInitialized();
    const iterator = this.transport.notifications()[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await nextWithAbort(iterator.next(), signal);
        if (next.done) {
          break;
        }
        const notification = next.value;
        if (notification.method !== 'account/login/completed') {
          continue;
        }
        const completed = parseLoginCompletedNotification(notification.params);
        if (completed.loginId !== null && completed.loginId !== loginId) {
          continue;
        }
        if (!completed.success) {
          throw new AppError(
            'unauthenticated',
            'ChatGPT authorization did not complete.',
            'Press l to try again.'
          );
        }
        return;
      }
    } finally {
      await iterator.return?.();
    }
    throw new AppError(
      'processFailed',
      'Codex app-server closed during authorization.',
      'Press l to try again.'
    );
  }

  close(): Promise<void> {
    this.initialized = false;
    this.runtimeInfo = undefined;
    return this.transport.close();
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error('App-server client has not been initialized.');
    }
  }
}

async function nextWithAbort<T>(
  next: Promise<IteratorResult<T>>,
  signal?: AbortSignal
): Promise<IteratorResult<T>> {
  if (signal === undefined) {
    return next;
  }
  if (signal.aborted) {
    throw signal.reason;
  }
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, {once: true});
    void next.then(
      result => {
        signal.removeEventListener('abort', aborted);
        resolve(result);
      },
      error => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      }
    );
  });
}
