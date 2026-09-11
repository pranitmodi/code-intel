import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const REEXEC_MARKER = 'CODE_INTEL_SYSTEM_CA_REEXEC';

export function systemCaAlreadyEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_USE_SYSTEM_CA === '1' ||
    env.NODE_OPTIONS?.split(/\s+/).includes('--use-system-ca') === true ||
    Boolean(env.NODE_EXTRA_CA_CERTS && existsSync(env.NODE_EXTRA_CA_CERTS))
  );
}

export function canUseSystemCa(): boolean {
  return process.allowedNodeEnvironmentFlags?.has('--use-system-ca') === true;
}

export function systemCaChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nodeOptions = [env.NODE_OPTIONS, '--use-system-ca'].filter(Boolean).join(' ');
  const childEnv = { ...env };
  delete childEnv.NODE_TLS_REJECT_UNAUTHORIZED;
  if (childEnv.NODE_EXTRA_CA_CERTS && !existsSync(childEnv.NODE_EXTRA_CA_CERTS)) {
    delete childEnv.NODE_EXTRA_CA_CERTS;
  }
  return {
    ...childEnv,
    NODE_USE_SYSTEM_CA: '1',
    NODE_OPTIONS: nodeOptions,
    [REEXEC_MARKER]: '1'
  };
}

export interface SystemCaRelaunchOptions {
  argv?: string[];
  execArgv?: string[];
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe';
}

/**
 * Relaunch the current CLI once so Node reads the system-CA option at process
 * startup. Returns the child's exit status in the parent, or undefined when
 * the current process is already configured.
 */
export function relaunchWithSystemCa(options: SystemCaRelaunchOptions = {}): number | undefined {
  const env = options.env ?? process.env;
  if (systemCaAlreadyEnabled(env) || env[REEXEC_MARKER] === '1') return undefined;
  if (!canUseSystemCa()) {
    throw new Error(
      'This Node.js version cannot use the operating system certificate store. Upgrade Node.js or set NODE_EXTRA_CA_CERTS to your company CA PEM file.'
    );
  }

  const result = spawnSync(
    options.execPath ?? process.execPath,
    [...(options.execArgv ?? process.execArgv), ...(options.argv ?? process.argv.slice(1))],
    {
      stdio: options.stdio ?? 'inherit',
      env: systemCaChildEnv(env)
    }
  );
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`System-CA child process exited from signal ${result.signal}.`);
  }
  return result.status ?? 1;
}

export function cursorSystemCaEnv(existingNodeOptions?: string): Record<string, string> {
  const nodeOptions = existingNodeOptions?.split(/\s+/).includes('--use-system-ca')
    ? existingNodeOptions
    : [existingNodeOptions, '--use-system-ca'].filter(Boolean).join(' ');
  return {
    NODE_USE_SYSTEM_CA: '1',
    NODE_OPTIONS: nodeOptions
  };
}
