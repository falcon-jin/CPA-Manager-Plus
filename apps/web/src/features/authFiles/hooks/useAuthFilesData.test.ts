import { act, createElement, type ChangeEvent } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => {
  return {
    mocks: {
      list: vi.fn(),
      saveJsonObject: vi.fn(),
      uploadFiles: vi.fn(),
      patchFields: vi.fn(),
      deleteFiles: vi.fn(),
      showNotification: vi.fn(),
      showConfirmation: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && typeof options.name === 'string') {
        return `${key}:${options.name}`;
      }
      return key;
    },
  }),
}));

vi.mock('@/stores', () => ({
  useNotificationStore: () => ({
    showNotification: mocks.showNotification,
    showConfirmation: mocks.showConfirmation,
  }),
}));

vi.mock('@/services/api', () => ({
  authFilesApi: {
    list: mocks.list,
    saveJsonObject: mocks.saveJsonObject,
    uploadFiles: mocks.uploadFiles,
    patchFields: mocks.patchFields,
    deleteFiles: mocks.deleteFiles,
  },
}));

import { buildPastedAuthJsonPayload, useAuthFilesData } from './useAuthFilesData';

type UseAuthFilesDataHarness = {
  getCurrent: () => ReturnType<typeof useAuthFilesData>;
  getSavingHistory: () => boolean[];
  unmount: () => void;
};

const mountUseAuthFilesData = (): UseAuthFilesDataHarness => {
  let hook: ReturnType<typeof useAuthFilesData> | null = null;
  let lastSavingState: boolean | undefined;
  const savingHistory: boolean[] = [];
  let renderer: ReactTestRenderer | null = null;

  const captureHook = (value: ReturnType<typeof useAuthFilesData>) => {
    hook = value;
    if (value.authJsonPasteSaving !== lastSavingState) {
      lastSavingState = value.authJsonPasteSaving;
      savingHistory.push(value.authJsonPasteSaving);
    }
  };

  function HookHarness() {
    captureHook(useAuthFilesData());
    return null;
  }

  act(() => {
    renderer = create(createElement(HookHarness));
  });

  return {
    getCurrent: () => {
      if (!hook) {
        throw new Error('Failed to mount useAuthFilesData test harness');
      }
      return hook;
    },
    getSavingHistory: () => [...savingHistory],
    unmount: () => {
      if (!renderer) return;
      act(() => {
        renderer?.unmount();
      });
    },
  };
};

beforeEach(() => {
  mocks.list.mockReset();
  mocks.saveJsonObject.mockReset();
  mocks.uploadFiles.mockReset();
  mocks.patchFields.mockReset();
  mocks.deleteFiles.mockReset();
  mocks.showNotification.mockReset();
  mocks.showConfirmation.mockReset();

  mocks.list.mockResolvedValue({ files: [] });
  mocks.saveJsonObject.mockResolvedValue(undefined);
  mocks.uploadFiles.mockResolvedValue({ uploaded: 0, failed: [], files: [] });
  mocks.patchFields.mockResolvedValue(undefined);
  mocks.deleteFiles.mockResolvedValue({ deleted: 0, failed: [], files: [] });
});

describe('buildPastedAuthJsonPayload', () => {
  it('keeps explicit file names for pasted CPA auth JSON', () => {
    const input = {
      type: 'codex',
      email: 'user@example.com',
      access_token: 'existing-access-token',
    };

    const result = buildPastedAuthJsonPayload('cpa', 'custom-auth.json', JSON.stringify(input));

    expect(result.resolvedFileName).toBe('custom-auth.json');
    expect(result.authJson).toEqual(input);
  });

  it('keeps explicit file names for pasted session auth JSON when a custom name is provided', () => {
    const result = buildPastedAuthJsonPayload(
      'session',
      'my-work-account.json',
      JSON.stringify({
        user: { email: 'Session.User+tag@example.com' },
        account: { id: 'session-account' },
        accessToken: 'plain-access-token',
      })
    );

    expect(result.resolvedFileName).toBe('my-work-account.json');
  });

  it('derives a default codex file name for pasted session auth JSON', () => {
    const result = buildPastedAuthJsonPayload(
      'session',
      'codex-account.json',
      JSON.stringify({
        user: { email: 'Session.User+tag@example.com' },
        account: { id: 'session-account' },
        accessToken: 'plain-access-token',
      })
    );

    expect(result.resolvedFileName).toBe('session-user-tag-example-com.codex.json');
    expect(result.authJson).toMatchObject({
      type: 'codex',
      email: 'Session.User+tag@example.com',
      account_id: 'session-account',
      access_token: 'plain-access-token',
    });
  });
});

describe('useAuthFilesData savePastedAuthJson', () => {
  it('saves converted session JSON with derived default file name and reloads files', async () => {
    const hook = mountUseAuthFilesData();
    const sessionInput = JSON.stringify({
      user: { email: 'Session.User+tag@example.com' },
      account: { id: 'session-account' },
      accessToken: 'plain-access-token',
    });

    const savedName = await hook
      .getCurrent()
      .savePastedAuthJson('session', 'codex-account.json', sessionInput);

    expect(savedName).toBe('session-user-tag-example-com.codex.json');
    expect(mocks.saveJsonObject).toHaveBeenCalledWith(
      'session-user-tag-example-com.codex.json',
      expect.objectContaining({
        type: 'codex',
        email: 'Session.User+tag@example.com',
        account_id: 'session-account',
        access_token: 'plain-access-token',
      })
    );
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.paste_success:session-user-tag-example-com.codex.json',
      'success'
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('saves CPA JSON unchanged with explicit file name', async () => {
    const hook = mountUseAuthFilesData();
    const cpaInput = {
      type: 'codex',
      email: 'user@example.com',
      access_token: 'existing-access-token',
    };

    const savedName = await hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', JSON.stringify(cpaInput));

    expect(savedName).toBe('custom-auth.json');
    expect(mocks.saveJsonObject).toHaveBeenCalledWith('custom-auth.json', cpaInput);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('waits for file reload completion before resolving pasted save success', async () => {
    const hook = mountUseAuthFilesData();
    const validInput = JSON.stringify({
      type: 'codex',
      email: 'user@example.com',
      access_token: 'existing-access-token',
    });
    let resolveList: (() => void) | undefined;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise<{ files: [] }>((resolve) => {
          resolveList = () => resolve({ files: [] });
        })
    );

    const settled = vi.fn();
    const savePromise = hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', validInput);
    void savePromise.then(settled);

    await Promise.resolve();
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();

    expect(resolveList).toBeTypeOf('function');
    resolveList?.();
    await savePromise;
    expect(settled).toHaveBeenCalledWith('custom-auth.json');
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.paste_success:custom-auth.json',
      'success'
    );
    hook.unmount();
  });

  it('sets authJsonPasteSaving true during save and resets false after success', async () => {
    const hook = mountUseAuthFilesData();
    const validInput = JSON.stringify({
      type: 'codex',
      email: 'user@example.com',
      access_token: 'existing-access-token',
    });
    let resolveUpload: (() => void) | undefined;
    mocks.saveJsonObject.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUpload = resolve;
        })
    );

    const savePromise = hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', validInput);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.getCurrent().authJsonPasteSaving).toBe(true);

    expect(resolveUpload).toBeTypeOf('function');
    resolveUpload?.();
    await expect(savePromise).resolves.toBe('custom-auth.json');
    await act(async () => {
      await Promise.resolve();
    });

    expect(hook.getCurrent().authJsonPasteSaving).toBe(false);
    const savingHistory = hook.getSavingHistory();
    expect(savingHistory).toContain(true);
    expect(savingHistory[savingHistory.length - 1]).toBe(false);
    hook.unmount();
  });

  it('rejects a concurrent pasted save before starting a duplicate upload', async () => {
    const hook = mountUseAuthFilesData();
    const validInput = JSON.stringify({
      type: 'codex',
      email: 'user@example.com',
      access_token: 'existing-access-token',
    });
    let resolveUpload: (() => void) | undefined;
    mocks.saveJsonObject.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUpload = resolve;
        })
    );

    const firstSave = hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', validInput);
    await expect(
      hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', validInput)
    ).rejects.toThrow('auth_files.paste_error_save_in_progress');

    expect(mocks.saveJsonObject).toHaveBeenCalledTimes(1);
    expect(resolveUpload).toBeTypeOf('function');
    resolveUpload?.();
    await expect(firstSave).resolves.toBe('custom-auth.json');
    hook.unmount();
  });

  it('throws on invalid conversion and does not upload or show success notification', async () => {
    const hook = mountUseAuthFilesData();
    const invalidInput = JSON.stringify({ foo: 'bar' });

    await expect(hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', invalidInput)).rejects.toThrow();

    expect(mocks.saveJsonObject).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('throws a generic save failure on upload failure and does not show success notification or reload files', async () => {
    const hook = mountUseAuthFilesData();
    const validInput = JSON.stringify({
      type: 'codex',
      email: 'user@example.com',
      access_token: 'existing-access-token',
    });
    mocks.saveJsonObject.mockRejectedValueOnce(
      new Error('upload failed for token sk-secret-value')
    );

    await expect(hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', validInput)).rejects.toThrow(
      'notification.save_failed'
    );

    expect(mocks.showNotification).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('resolves saved file name when reload fails after upload and shows refresh warning', async () => {
    const hook = mountUseAuthFilesData();
    const validInput = JSON.stringify({
      type: 'codex',
      email: 'user@example.com',
      access_token: 'existing-access-token',
    });
    mocks.list.mockClear();
    mocks.list.mockRejectedValueOnce(new Error('reload failed'));

    await expect(
      hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', validInput)
    ).resolves.toBe('custom-auth.json');

    expect(mocks.saveJsonObject).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.paste_success:custom-auth.json',
      'success'
    );
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'notification.refresh_failed: reload failed',
      'warning'
    );
    hook.unmount();
  });

  it('sets authJsonPasteSaving true during save and resets false after failure', async () => {
    const hook = mountUseAuthFilesData();
    const validInput = JSON.stringify({
      type: 'codex',
      email: 'user@example.com',
      access_token: 'existing-access-token',
    });
    let rejectUpload: ((reason?: unknown) => void) | undefined;
    mocks.saveJsonObject.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectUpload = reject;
        })
    );

    const savePromise = hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', validInput);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.getCurrent().authJsonPasteSaving).toBe(true);

    expect(rejectUpload).toBeTypeOf('function');
    rejectUpload?.(new Error('upload failed'));
    await expect(savePromise).rejects.toThrow('notification.save_failed');
    await act(async () => {
      await Promise.resolve();
    });

    expect(hook.getCurrent().authJsonPasteSaving).toBe(false);
    const savingHistory = hook.getSavingHistory();
    expect(savingHistory).toContain(true);
    expect(savingHistory[savingHistory.length - 1]).toBe(false);
    hook.unmount();
  });

  it('allows retrying pasted save after an upload failure', async () => {
    const hook = mountUseAuthFilesData();
    const validInput = JSON.stringify({
      type: 'codex',
      email: 'user@example.com',
      access_token: 'existing-access-token',
    });
    mocks.saveJsonObject.mockRejectedValueOnce(new Error('upload failed'));

    await expect(hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', validInput)).rejects.toThrow(
      'notification.save_failed'
    );
    await expect(hook.getCurrent().savePastedAuthJson('cpa', 'custom-auth.json', validInput)).resolves.toBe(
      'custom-auth.json'
    );

    expect(mocks.saveJsonObject).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.paste_success:custom-auth.json',
      'success'
    );
    hook.unmount();
  });
});

describe('useAuthFilesData handleFileChange', () => {
  it('extracts JSON files from uploaded zip archives before upload', async () => {
    const hook = mountUseAuthFilesData();
    const zipFile = new File(
      [
        new Blob([
          zipSync({
            'auth/codex-a.json': strToU8('{"type":"codex","access_token":"a"}'),
            'auth/readme.txt': strToU8('ignored'),
          }),
        ]),
      ],
      'auth-files.zip',
      { type: 'application/zip' }
    );
    mocks.uploadFiles.mockResolvedValueOnce({
      uploaded: 1,
      failed: [],
      files: ['codex-a.json'],
    });

    await act(async () => {
      await hook.getCurrent().handleFileChange({
        target: {
          files: [zipFile],
          value: 'auth-files.zip',
        },
      } as unknown as ChangeEvent<HTMLInputElement>);
    });

    expect(mocks.uploadFiles).toHaveBeenCalledTimes(1);
    const uploadedFiles = mocks.uploadFiles.mock.calls[0][0] as File[];
    expect(uploadedFiles).toHaveLength(1);
    expect(uploadedFiles[0].name).toBe('codex-a.json');
    await expect(uploadedFiles[0].text()).resolves.toBe(
      '{"type":"codex","access_token":"a"}'
    );
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.upload_success',
      'success'
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('rejects archives without JSON files', async () => {
    const hook = mountUseAuthFilesData();
    const zipFile = new File(
      [new Blob([zipSync({ 'readme.txt': strToU8('ignored') })])],
      'empty-auth.zip',
      { type: 'application/zip' }
    );

    await act(async () => {
      await hook.getCurrent().handleFileChange({
        target: {
          files: [zipFile],
          value: 'empty-auth.zip',
        },
      } as unknown as ChangeEvent<HTMLInputElement>);
    });

    expect(mocks.uploadFiles).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.upload_error_archive_empty',
      'warning'
    );
    hook.unmount();
  });
});

describe('useAuthFilesData handleDeleteAll', () => {
  it('deletes only the provided filtered files for custom result filters', async () => {
    const hook = mountUseAuthFilesData();
    const resetResultFilters = vi.fn();
    const resetFilterToAll = vi.fn();

    mocks.list.mockResolvedValueOnce({
      files: [
        { name: 'codex-limited.json', type: 'codex' },
        { name: 'codex-ok.json', type: 'codex' },
      ],
    });
    mocks.deleteFiles.mockResolvedValueOnce({
      deleted: 1,
      failed: [],
      files: ['codex-limited.json'],
    });

    await act(async () => {
      await hook.getCurrent().loadFiles();
    });

    act(() => {
      hook.getCurrent().handleDeleteAll({
        filter: 'all',
        problemOnly: false,
        disabledOnly: false,
        healthyOnly: false,
        filteredFiles: [{ name: 'codex-limited.json', type: 'codex' }],
        onResetFilterToAll: resetFilterToAll,
        onResetProblemOnly: vi.fn(),
        onResetDisabledOnly: vi.fn(),
        onResetHealthyOnly: vi.fn(),
        onResetResultFilters: resetResultFilters,
      });
    });

    const confirmation = mocks.showConfirmation.mock.calls[0]?.[0] as
      | { onConfirm?: () => Promise<void> }
      | undefined;
    expect(confirmation?.onConfirm).toBeTypeOf('function');
    expect(mocks.showConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'auth_files.delete_filtered_result_confirm_file_scope',
      })
    );

    await act(async () => {
      await confirmation?.onConfirm?.();
    });

    expect(mocks.deleteFiles).toHaveBeenCalledWith(['codex-limited.json']);
    expect(resetFilterToAll).not.toHaveBeenCalled();
    expect(resetResultFilters).toHaveBeenCalledTimes(1);
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.delete_filtered_result_success',
      'success'
    );
    hook.unmount();
  });
});

describe('useAuthFilesData batchSetPriority', () => {
  it('sets priority for selected persisted auth files', async () => {
    const hook = mountUseAuthFilesData();
    mocks.list.mockResolvedValueOnce({
      files: [
        { name: 'codex-a.json', type: 'codex', priority: 1 },
        { name: 'codex-b.json', type: 'codex' },
        { name: 'runtime.json', type: 'codex', runtimeOnly: true },
      ],
    });

    await act(async () => {
      await hook.getCurrent().loadFiles();
    });

    await act(async () => {
      await hook.getCurrent().batchSetPriority(
        ['codex-a.json', 'codex-b.json', 'runtime.json'],
        10
      );
    });

    expect(mocks.patchFields).toHaveBeenCalledTimes(2);
    expect(mocks.patchFields).toHaveBeenCalledWith('codex-a.json', { priority: 10 });
    expect(mocks.patchFields).toHaveBeenCalledWith('codex-b.json', { priority: 10 });
    expect(hook.getCurrent().files.find((file) => file.name === 'codex-a.json')?.priority).toBe(
      10
    );
    expect(hook.getCurrent().files.find((file) => file.name === 'codex-b.json')?.priority).toBe(
      10
    );
    expect(hook.getCurrent().files.find((file) => file.name === 'runtime.json')?.priority).toBe(
      undefined
    );
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.batch_priority_success',
      'success'
    );
    hook.unmount();
  });

  it('reverts only failed priority updates', async () => {
    const hook = mountUseAuthFilesData();
    mocks.list.mockResolvedValueOnce({
      files: [
        { name: 'codex-a.json', type: 'codex', priority: 1 },
        { name: 'codex-b.json', type: 'codex', priority: 2 },
      ],
    });
    mocks.patchFields
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('patch failed'));

    await act(async () => {
      await hook.getCurrent().loadFiles();
    });

    await act(async () => {
      await hook.getCurrent().batchSetPriority(['codex-a.json', 'codex-b.json'], 0);
    });

    expect(hook.getCurrent().files.find((file) => file.name === 'codex-a.json')?.priority).toBe(
      undefined
    );
    expect(hook.getCurrent().files.find((file) => file.name === 'codex-b.json')?.priority).toBe(2);
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.batch_priority_partial',
      'warning'
    );
    hook.unmount();
  });
});
