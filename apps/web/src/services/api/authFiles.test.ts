import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    get: vi.fn(),
    postForm: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./client', () => ({
  apiClient: {
    get: mocks.get,
    postForm: mocks.postForm,
    patch: mocks.patch,
    delete: mocks.delete,
  },
}));

import { authFilesApi } from './authFiles';

beforeEach(() => {
  vi.useRealTimers();
  mocks.get.mockReset();
  mocks.postForm.mockReset();
  mocks.patch.mockReset();
  mocks.delete.mockReset();
});

describe('authFilesApi list cache', () => {
  it('coalesces parallel list calls and reuses the short-lived result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    mocks.get.mockResolvedValue({
      files: [{ name: 'codex-a.json', type: 'codex' }],
    });

    await expect(Promise.all([authFilesApi.list(), authFilesApi.list()])).resolves.toEqual([
      { files: [{ name: 'codex-a.json', type: 'codex' }], total: 1 },
      { files: [{ name: 'codex-a.json', type: 'codex' }], total: 1 },
    ]);
    expect(mocks.get).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2_000);
    await expect(authFilesApi.list()).resolves.toMatchObject({
      files: [{ name: 'codex-a.json' }],
      total: 1,
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);

    vi.setSystemTime(20_000);
    mocks.get.mockResolvedValueOnce({
      files: [{ name: 'codex-b.json', type: 'codex' }],
    });
    await expect(authFilesApi.list()).resolves.toMatchObject({
      files: [{ name: 'codex-b.json' }],
      total: 1,
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cached list after auth file mutations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    mocks.get.mockResolvedValueOnce({
      files: [{ name: 'codex-a.json', type: 'codex', priority: 1 }],
    });
    mocks.patch.mockResolvedValue({ status: 'ok', disabled: false });

    await authFilesApi.list();
    await authFilesApi.patchFields('codex-a.json', { priority: 5 });

    mocks.get.mockResolvedValueOnce({
      files: [{ name: 'codex-a.json', type: 'codex', priority: 5 }],
    });
    await expect(authFilesApi.list()).resolves.toMatchObject({
      files: [{ name: 'codex-a.json', priority: 5 }],
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});

describe('authFilesApi list normalization', () => {
  it('preserves same-name auth file rows when authIndex differs', async () => {
    mocks.get.mockResolvedValue({
      files: [
        {
          name: 'sub2api-codex-accounts.codex.json',
          type: 'codex',
          authIndex: 1,
          account: 'second@example.com',
        },
        {
          name: 'sub2api-codex-accounts.codex.json',
          type: 'codex',
          authIndex: 0,
          account: 'first@example.com',
        },
      ],
    });

    const result = await authFilesApi.list({ force: true });

    expect(mocks.get).toHaveBeenCalledWith('/auth-files');
    expect(result.files).toEqual([
      expect.objectContaining({
        name: 'sub2api-codex-accounts.codex.json',
        authIndex: 0,
        account: 'first@example.com',
      }),
      expect.objectContaining({
        name: 'sub2api-codex-accounts.codex.json',
        authIndex: 1,
        account: 'second@example.com',
      }),
    ]);
    expect(result.total).toBe(2);
  });

  it('still merges duplicate same-name rows when authIndex is absent', async () => {
    mocks.get.mockResolvedValue({
      files: [
        {
          name: 'single-codex.json',
          type: 'codex',
          source: 'runtime',
          status: 'ok',
        },
        {
          name: 'single-codex.json',
          type: 'codex',
          source: 'file',
          path: '/auth/single-codex.json',
          size: 123,
        },
      ],
    });

    const result = await authFilesApi.list({ force: true });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual(
      expect.objectContaining({
        name: 'single-codex.json',
        source: 'file',
        path: '/auth/single-codex.json',
        size: 123,
        status: 'ok',
      })
    );
    expect(result.total).toBe(1);
  });
});

describe('authFilesApi save auth file upload contracts', () => {
  const getUploadedFile = () => {
    const formData = mocks.postForm.mock.calls[0]?.[1];
    expect(formData).toBeInstanceOf(FormData);
    const file = (formData as FormData).get('file');
    expect(file).toBeInstanceOf(File);
    return file as File;
  };

  it('saveText resolves when upload reports one uploaded file', async () => {
    // Arrange
    mocks.postForm.mockResolvedValue({
      status: 'ok',
      uploaded: 1,
      files: ['direct-auth.json'],
      failed: [],
    });

    // Act / Assert
    await expect(
      authFilesApi.saveText('direct-auth.json', '{"type":"codex","access_token":"token"}')
    ).resolves.toBeUndefined();
    expect(mocks.postForm).toHaveBeenCalledWith('/auth-files', expect.any(FormData));
    const file = getUploadedFile();
    expect(file.name).toBe('direct-auth.json');
    await expect(file.text()).resolves.toBe('{"type":"codex","access_token":"token"}');
  });

  it('saveJsonObject resolves when upload succeeds', async () => {
    // Arrange
    mocks.postForm.mockResolvedValue({
      status: 'ok',
      uploaded: 1,
      files: ['converted-auth.json'],
      failed: [],
    });

    // Act / Assert
    await expect(
      authFilesApi.saveJsonObject('converted-auth.json', {
        type: 'codex',
        access_token: 'token',
      })
    ).resolves.toBeUndefined();
    expect(mocks.postForm).toHaveBeenCalledWith('/auth-files', expect.any(FormData));
    const file = getUploadedFile();
    expect(file.name).toBe('converted-auth.json');
    await expect(file.text()).resolves.toBe('{"type":"codex","access_token":"token"}');
  });

  it('saveJsonObject serializes auth file arrays without wrapping them', async () => {
    // Arrange
    mocks.postForm.mockResolvedValue({
      status: 'ok',
      uploaded: 1,
      files: ['converted-auth-array.json'],
      failed: [],
    });

    // Act / Assert
    await expect(
      authFilesApi.saveJsonObject('converted-auth-array.json', [
        {
          type: 'codex',
          access_token: 'first-token',
        },
        {
          type: 'codex',
          access_token: 'second-token',
        },
      ])
    ).resolves.toBeUndefined();
    expect(mocks.postForm).toHaveBeenCalledWith('/auth-files', expect.any(FormData));
    const file = getUploadedFile();
    expect(file.name).toBe('converted-auth-array.json');
    await expect(file.text()).resolves.toBe(
      '[{"type":"codex","access_token":"first-token"},{"type":"codex","access_token":"second-token"}]'
    );
  });

  it('saveJsonObject throws Upload failed when backend reports zero uploaded files without explicit failures', async () => {
    // Arrange
    mocks.postForm.mockResolvedValue({
      status: 'ok',
      uploaded: 0,
      files: [],
      failed: [],
    });

    // Act / Assert
    await expect(
      authFilesApi.saveJsonObject('failed-converted-auth.json', {
        type: 'codex',
        access_token: 'token',
      })
    ).rejects.toThrow('Upload failed');
  });

  it('saveText throws Upload failed when backend reports zero uploaded files without explicit failures', async () => {
    // Arrange
    mocks.postForm.mockResolvedValue({
      status: 'ok',
      uploaded: 0,
      files: [],
      failed: [],
    });

    // Act / Assert
    await expect(authFilesApi.saveText('failed-auth.json', '{"type":"codex"}')).rejects.toThrow(
      'Upload failed'
    );
  });

  it('saveJsonObject surfaces backend failure error text', async () => {
    // Arrange
    mocks.postForm.mockResolvedValue({
      status: 'partial',
      uploaded: 0,
      files: [],
      failed: [{ name: 'converted-auth.json', error: 'Storage quota exceeded' }],
    });

    // Act / Assert
    await expect(
      authFilesApi.saveJsonObject('converted-auth.json', {
        type: 'codex',
        access_token: 'token',
      })
    ).rejects.toThrow('Storage quota exceeded');
  });

  it('saveJsonObject throws when backend reports partial failure despite uploaded files', async () => {
    // Arrange
    mocks.postForm.mockResolvedValue({
      status: 'partial',
      uploaded: 1,
      files: ['converted-auth.json'],
      failed: [{ name: 'secondary-auth.json', error: 'Invalid auth payload' }],
    });

    // Act / Assert
    await expect(
      authFilesApi.saveJsonObject('converted-auth.json', {
        type: 'codex',
        access_token: 'token',
      })
    ).rejects.toThrow('Invalid auth payload');
  });

  it('saveJsonObject throws when backend reports explicit error status without upload counters', async () => {
    // Arrange
    mocks.postForm.mockResolvedValue({
      status: 'error',
      files: [],
      failed: [],
    });

    // Act / Assert
    await expect(
      authFilesApi.saveJsonObject('failed-status-auth.json', {
        type: 'codex',
        access_token: 'token',
      })
    ).rejects.toThrow('Upload failed');
  });
});
