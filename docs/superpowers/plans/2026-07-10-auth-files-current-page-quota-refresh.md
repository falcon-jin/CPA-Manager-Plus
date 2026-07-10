# Auth Files Current-Page Quota Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the auth-files page refresh quota for eligible credentials on the current page and provide an explicit per-card quota refresh button.

**Architecture:** Add a focused `useAuthFileQuotaRefresh` coordinator that owns provider selection, Zustand quota updates, duplicate-request suppression, and four-request batch concurrency. `AuthFilesPage` passes the coordinator's single-file callback to cards and sends the click-time `pageItems` snapshot to its batch callback; `AuthFileQuotaSection` remains a display component with an explicit refresh action.

**Tech Stack:** React 19, TypeScript 6, Zustand 5, Vitest 4, react-test-renderer, SCSS modules, react-i18next.

## Global Constraints

- Top refresh acts only on the `pageItems` visible at click time after filtering, sorting, and pagination.
- Compact mode still refreshes current-page quota even though inline quota details are hidden.
- Skip disabled, runtime-only, unsupported, and already-loading credentials.
- Support Antigravity, Claude, Codex, Kimi, and xAI through the existing quota configs and stores.
- Use at most 4 concurrent quota requests.
- A failed request must not stop other current-page requests.
- Preserve prior quota through provider `buildFailureState` when available.
- Per-card refresh keeps success/error notifications; batch refresh avoids per-card notification noise.
- Do not change the standalone quota-management page or add backend APIs.

---

## File Structure

- Create `apps/web/src/features/authFiles/hooks/useAuthFileQuotaRefresh.ts`: provider-aware single and current-page batch quota refresh coordinator.
- Create `apps/web/src/features/authFiles/hooks/useAuthFileQuotaRefresh.test.ts`: state, filtering, failure preservation, and concurrency regression tests.
- Modify `apps/web/src/features/authFiles/components/AuthFileQuotaSection.tsx`: render quota plus a permanent explicit refresh button and delegate requests to the coordinator.
- Modify `apps/web/src/features/authFiles/components/AuthFileQuotaSection.test.tsx`: verify the explicit button in loaded/error states and callback behavior.
- Modify `apps/web/src/features/authFiles/components/AuthFileCard.tsx`: carry the single-file refresh callback to the quota section.
- Modify `apps/web/src/features/authFiles/AuthFilesPage.tsx`: refresh click-time `pageItems`, expose loading state, and wire cards.
- Modify `apps/web/src/features/authFiles/AuthFilesPage.quotaCooldown.test.tsx`: capture the registered header callback and prove current-page/compact-mode scoping.
- Modify `apps/web/src/features/authFiles/AuthFilesPage.module.scss`: style the quota header and refresh action.

---

### Task 1: Add the shared auth-file quota refresh coordinator

**Files:**
- Create: `apps/web/src/features/authFiles/hooks/useAuthFileQuotaRefresh.test.ts`
- Create: `apps/web/src/features/authFiles/hooks/useAuthFileQuotaRefresh.ts`

**Interfaces:**
- Consumes: existing `QuotaConfig`, provider configs, `getQuotaStoreKey`, `getScopedQuotaState`, `buildQuotaFailureState`, `useQuotaStore`, and `AuthFileItem`.
- Produces:
  - `refreshQuotaForFile(file: AuthFileItem, options?: { notify?: boolean }): Promise<boolean>`
  - `refreshQuotaForFiles(files: AuthFileItem[]): Promise<void>`
  - `refreshingQuotaFiles: boolean`

- [ ] **Step 1: Write failing coordinator tests**

Create a hook harness with `react-test-renderer`, partially mock `@/stores` so the real `useQuotaStore` is retained, and mock `fetchCodexQuota` through `@/utils/quota`.

```tsx
const file: AuthFileItem = {
  name: 'team.json',
  type: 'codex',
  authIndex: 1,
};

it('refreshes one credential and stores the scoped Codex result', async () => {
  mocks.fetchCodexQuota.mockResolvedValue(codexQuotaData);
  const hook = mountHook();

  await act(async () => {
    expect(await hook.getCurrent().refreshQuotaForFile(file)).toBe(true);
  });

  expect(mocks.fetchCodexQuota).toHaveBeenCalledWith(file, expect.any(Function));
  expect(useQuotaStore.getState().codexQuota['team.json::1']).toMatchObject({
    status: 'success',
    authFileKey: 'team.json::1',
  });
  expect(mocks.showNotification).toHaveBeenCalledWith(
    'auth_files.quota_refresh_success:team.json',
    'success'
  );
});

it('preserves prior Codex windows when refresh fails', async () => {
  useQuotaStore.setState({
    codexQuota: {
      'team.json::1': {
        status: 'success',
        windows: [{ id: 'five-hour', label: '5-hour', usedPercent: 30 }],
        planType: 'team',
        subscriptionActiveUntil: null,
        rateLimitResetCreditsAvailableCount: 0,
        authFileKey: 'team.json::1',
        authFileName: 'team.json',
        authIndex: '1',
      },
    },
  });
  mocks.fetchCodexQuota.mockRejectedValue(new Error('refresh failed'));
  const hook = mountHook();

  await act(async () => {
    expect(await hook.getCurrent().refreshQuotaForFile(file, { notify: false })).toBe(false);
  });

  expect(useQuotaStore.getState().codexQuota['team.json::1']).toMatchObject({
    status: 'error',
    error: 'refresh failed',
    windows: [{ id: 'five-hour', usedPercent: 30 }],
  });
});

it('filters current-page targets before requesting quota', async () => {
  mocks.fetchCodexQuota.mockResolvedValue(codexQuotaData);
  const hook = mountHook();

  await act(async () => {
    await hook.getCurrent().refreshQuotaForFiles([
      file,
      { name: 'disabled.json', type: 'codex', disabled: true },
      { name: 'runtime.json', type: 'codex', runtimeOnly: true },
      { name: 'unsupported.json', type: 'qwen' },
    ]);
  });

  expect(mocks.fetchCodexQuota).toHaveBeenCalledTimes(1);
  expect(mocks.fetchCodexQuota).toHaveBeenCalledWith(file, expect.any(Function));
  expect(mocks.showNotification).not.toHaveBeenCalled();
});

it('runs at most four current-page requests concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.fetchCodexQuota.mockImplementation(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate;
    active -= 1;
    return codexQuotaData;
  });
  const hook = mountHook();
  const files = Array.from({ length: 5 }, (_, index) => ({
    name: `team-${index}.json`,
    type: 'codex',
    authIndex: index,
  }));

  let refreshPromise!: Promise<void>;
  act(() => {
    refreshPromise = hook.getCurrent().refreshQuotaForFiles(files);
  });
  await vi.waitFor(() => expect(mocks.fetchCodexQuota).toHaveBeenCalledTimes(4));
  expect(maxActive).toBe(4);
  release();
  await act(async () => refreshPromise);

  expect(mocks.fetchCodexQuota).toHaveBeenCalledTimes(5);
  expect(maxActive).toBe(4);
});
```

Reset all five quota maps and mocks in `beforeEach`. Define `codexQuotaData` with every required field:

```ts
const codexQuotaData = {
  planType: 'team',
  windows: [],
  subscriptionActiveUntil: null,
  rateLimitResetCreditsAvailableCount: 0,
  rateLimitResetCredits: [],
  rateLimitResetCreditsError: null,
};
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
npm --workspace apps/web run test -- src/features/authFiles/hooks/useAuthFileQuotaRefresh.test.ts
```

Expected: FAIL because `useAuthFileQuotaRefresh.ts` does not exist.

- [ ] **Step 3: Implement the coordinator**

Create `useAuthFileQuotaRefresh.ts` with a provider switch and one generic executor. Use this exact public shape:

```ts
export type RefreshAuthFileQuotaOptions = { notify?: boolean };

export type UseAuthFileQuotaRefreshResult = {
  refreshQuotaForFile: (
    file: AuthFileItem,
    options?: RefreshAuthFileQuotaOptions
  ) => Promise<boolean>;
  refreshQuotaForFiles: (files: AuthFileItem[]) => Promise<void>;
  refreshingQuotaFiles: boolean;
};
```

The internal executor must:

```ts
const state = useQuotaStore.getState() as QuotaStore;
const storedQuota = config.storeSelector(state);
const previousQuota = getScopedQuotaState(config, storedQuota, file);
const storeKey = getQuotaStoreKey(config, file);
const requestKey = `${config.type}:${storeKey}`;

if (isRuntimeOnlyAuthFile(file) || !config.filterFn(file)) return false;
if ((previousQuota as { status?: string } | undefined)?.status === 'loading') return false;
if (inFlightRef.current.has(requestKey)) return false;
```

Cast only the config-selected setter through `unknown`:

```ts
type QuotaSetter<TState> = (
  updater:
    | Record<string, TState>
    | ((previous: Record<string, TState>) => Record<string, TState>)
) => void;

const setQuota = state[config.storeSetter] as unknown as QuotaSetter<TState>;
```

Write loading before fetching, success after fetching, and use `buildQuotaFailureState` in the catch block. Add/remove `requestKey` in `try/finally`. Notify only when `options.notify !== false`.

Implement the provider switch without erasing config generics:

```ts
switch (resolveAuthProvider(file)) {
  case 'antigravity':
    return executeQuotaRefresh(ANTIGRAVITY_CONFIG, file, options);
  case 'claude':
    return executeQuotaRefresh(CLAUDE_CONFIG, file, options);
  case 'codex':
    return executeQuotaRefresh(CODEX_CONFIG, file, options);
  case 'kimi':
    return executeQuotaRefresh(KIMI_CONFIG, file, options);
  case 'xai':
    return executeQuotaRefresh(XAI_CONFIG, file, options);
  default:
    return false;
}
```

Implement four-request batching without a second concurrency utility:

```ts
for (let index = 0; index < files.length; index += 4) {
  const batch = files.slice(index, index + 4);
  await Promise.all(
    batch.map((file) => refreshQuotaForFile(file, { notify: false }))
  );
}
```

Guard overlapping page batches with a ref, expose `refreshingQuotaFiles` through `useState`, and always clear both in `finally`.

- [ ] **Step 4: Run the coordinator test and verify GREEN**

Run:

```powershell
npm --workspace apps/web run test -- src/features/authFiles/hooks/useAuthFileQuotaRefresh.test.ts
```

Expected: `1` test file passes and all four coordinator tests pass.

- [ ] **Step 5: Commit the coordinator**

```powershell
git add -- apps/web/src/features/authFiles/hooks/useAuthFileQuotaRefresh.ts apps/web/src/features/authFiles/hooks/useAuthFileQuotaRefresh.test.ts
git commit -m "feat(auth-files): coordinate quota refreshes"
```

---

### Task 2: Add the permanent per-card quota refresh button

**Files:**
- Modify: `apps/web/src/features/authFiles/components/AuthFileQuotaSection.test.tsx`
- Modify: `apps/web/src/features/authFiles/components/AuthFileQuotaSection.tsx`
- Modify: `apps/web/src/features/authFiles/components/AuthFileCard.tsx`
- Modify: `apps/web/src/features/authFiles/AuthFilesPage.module.scss`

**Interfaces:**
- Consumes: `refreshQuotaForFile(file)` from Task 1.
- Produces:
  - `AuthFileCardProps.onRefreshQuota: (file: AuthFileItem) => void | Promise<unknown>`
  - `AuthFileQuotaSectionProps.onRefreshQuota: (file: AuthFileItem) => void | Promise<unknown>`

- [ ] **Step 1: Write failing button tests**

Replace the component test's direct quota-fetch mocks with `mocks.refreshQuota`. Pass it to the rendered section and add these cases:

```tsx
it('shows an explicit refresh button when quota is already loaded', () => {
  const renderer = renderSection(matchingQuota);

  expect(getText(renderer.root)).toContain('codex_quota.plan_pro');
  expect(findButtonByText(renderer, 'auth_files.quota_refresh_single')).toBeDefined();
});

it('delegates refresh for the current credential', async () => {
  const renderer = renderSection(matchingQuota);

  await act(async () => {
    findButtonByText(renderer, 'auth_files.quota_refresh_single').props.onClick();
  });

  expect(mocks.refreshQuota).toHaveBeenCalledWith(file);
});

it('disables the refresh button while quota is loading', () => {
  const renderer = renderSection({ ...matchingQuota, status: 'loading' });

  expect(findButtonByText(renderer, 'auth_files.quota_refresh_single').props.disabled).toBe(true);
});
```

Remove the old component-level “preserves prior quota on refresh failure” case because Task 1 now owns and tests that behavior.

- [ ] **Step 2: Run the component test and verify RED**

Run:

```powershell
npm --workspace apps/web run test -- src/features/authFiles/components/AuthFileQuotaSection.test.tsx
```

Expected: FAIL because loaded quota does not render `auth_files.quota_refresh_single` and the callback prop is ignored.

- [ ] **Step 3: Delegate quota requests and render the explicit button**

In `AuthFileQuotaSection.tsx`:

- Remove `useCallback`, notification-store access, setter selection, `getStatusFromError`, and the local `refreshQuotaForFile` implementation.
- Keep the config and quota-store selectors used for display.
- Add `IconRefreshCw` and the callback prop.
- Render a header before quota content:

```tsx
<div className={styles.quotaSectionHeader}>
  <button
    type="button"
    className={styles.quotaRefreshButton}
    onClick={() => void onRefreshQuota(file)}
    disabled={!canRefreshQuota || quotaStatus === 'loading'}
    title={t('auth_files.quota_refresh_hint')}
    aria-label={t('auth_files.quota_refresh_hint')}
  >
    <IconRefreshCw size={13} aria-hidden="true" />
    {t('auth_files.quota_refresh_single')}
  </button>
</div>
```

Change the idle branch back to a non-button message:

```tsx
<div className={styles.quotaMessage}>{t(`${config.i18nPrefix}.idle`)}</div>
```

In `AuthFileCard.tsx`, add `onRefreshQuota` to the prop type/destructure and pass it to `AuthFileQuotaSection`.

Add SCSS that keeps the action compact and right-aligned:

```scss
.quotaSectionHeader {
  display: flex;
  justify-content: flex-end;
}

.quotaRefreshButton {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--primary-color);
    color: var(--primary-color);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
}
```

- [ ] **Step 4: Run the component test and verify GREEN**

Run:

```powershell
npm --workspace apps/web run test -- src/features/authFiles/components/AuthFileQuotaSection.test.tsx
```

Expected: the component test file passes.

- [ ] **Step 5: Commit the card action**

```powershell
git add -- apps/web/src/features/authFiles/components/AuthFileQuotaSection.test.tsx apps/web/src/features/authFiles/components/AuthFileQuotaSection.tsx apps/web/src/features/authFiles/components/AuthFileCard.tsx apps/web/src/features/authFiles/AuthFilesPage.module.scss
git commit -m "feat(auth-files): add quota refresh action"
```

---

### Task 3: Wire top refresh to the click-time current page

**Files:**
- Modify: `apps/web/src/features/authFiles/AuthFilesPage.quotaCooldown.test.tsx`
- Modify: `apps/web/src/features/authFiles/AuthFilesPage.tsx`

**Interfaces:**
- Consumes: all three values from `useAuthFileQuotaRefresh()`.
- Produces: header refresh that awaits the existing page loads plus `refreshQuotaForFiles(pageItems)` and card wiring through `onRefreshQuota`.

- [ ] **Step 1: Write failing current-page integration tests**

Extend the hoisted mocks:

```ts
headerRefresh: null as null | (() => Promise<void>),
refreshQuotaForFile: vi.fn(async () => true),
refreshQuotaForFiles: vi.fn(async () => undefined),
refreshingQuotaFiles: false,
persistedCompactMode: null as boolean | null,
```

Capture the registered callback and mock the new hook:

```ts
vi.mock('@/hooks/useHeaderRefresh', () => ({
  useHeaderRefresh: (callback: () => Promise<void>) => {
    mocks.headerRefresh = callback;
  },
}));

vi.mock('@/features/authFiles/hooks/useAuthFileQuotaRefresh', () => ({
  useAuthFileQuotaRefresh: () => ({
    refreshQuotaForFile: mocks.refreshQuotaForFile,
    refreshQuotaForFiles: mocks.refreshQuotaForFiles,
    refreshingQuotaFiles: mocks.refreshingQuotaFiles,
  }),
}));
```

Make `readPersistedAuthFilesCompactMode` return `mocks.persistedCompactMode`, reset it to `null` in `beforeEach`, and add:

```tsx
it('refreshes quota only for credentials rendered on the current page', async () => {
  mocks.list.mockReturnValue(
    Array.from({ length: 10 }, (_, index) => ({
      name: `team-${String(index).padStart(2, '0')}.json`,
      type: 'codex',
      authIndex: index,
    }))
  );
  const renderer = renderPage();
  const visibleNames = renderer.root
    .findAll((node) => typeof node.props['data-auth-card'] === 'string')
    .map((node) => node.props['data-auth-card'] as string);

  await act(async () => {
    await mocks.headerRefresh?.();
  });

  const refreshed = mocks.refreshQuotaForFiles.mock.calls[0][0] as Array<{ name: string }>;
  expect(refreshed.map((item) => item.name)).toEqual(visibleNames);
  expect(refreshed).toHaveLength(9);
});

it('refreshes compact-mode current-page quota without inline quota sections', async () => {
  mocks.persistedCompactMode = true;
  mocks.list.mockReturnValue(
    Array.from({ length: 31 }, (_, index) => ({
      name: `compact-${String(index).padStart(2, '0')}.json`,
      type: 'codex',
      authIndex: index,
    }))
  );
  renderPage();

  await act(async () => {
    await mocks.headerRefresh?.();
  });

  expect(mocks.refreshQuotaForFiles.mock.calls[0][0]).toHaveLength(30);
});
```

- [ ] **Step 2: Run the page test and verify RED**

Run:

```powershell
npm --workspace apps/web run test -- src/features/authFiles/AuthFilesPage.quotaCooldown.test.tsx
```

Expected: FAIL because the page neither calls the coordinator nor passes its callback to cards.

- [ ] **Step 3: Wire the page**

Import and call the hook near `useAuthFilesData`:

```ts
const {
  refreshQuotaForFile,
  refreshQuotaForFiles,
  refreshingQuotaFiles,
} = useAuthFileQuotaRefresh();
```

Move `handleHeaderRefresh` and `useHeaderRefresh(handleHeaderRefresh)` below the `pageItems` calculation so `pageItems` can be a dependency. Preserve click-time scope:

```ts
const handleHeaderRefresh = useCallback(async () => {
  const quotaTargets = pageItems;
  await Promise.all([
    loadFiles({ force: true }),
    loadExcluded(),
    loadModelAlias(),
    loadCodexInspectionSnapshots(),
    refreshQuotaForFiles(quotaTargets),
  ]);
}, [
  loadFiles,
  loadExcluded,
  loadModelAlias,
  loadCodexInspectionSnapshots,
  pageItems,
  refreshQuotaForFiles,
]);

useHeaderRefresh(handleHeaderRefresh);
```

Update the page refresh button:

```tsx
<Button
  variant="secondary"
  size="sm"
  onClick={handleHeaderRefresh}
  disabled={loading || refreshingQuotaFiles}
  loading={loading || refreshingQuotaFiles}
>
  {t('common.refresh')}
</Button>
```

Pass the callback to every card:

```tsx
onRefreshQuota={refreshQuotaForFile}
```

- [ ] **Step 4: Run the page and component tests and verify GREEN**

Run:

```powershell
npm --workspace apps/web run test -- src/features/authFiles/AuthFilesPage.quotaCooldown.test.tsx src/features/authFiles/components/AuthFileQuotaSection.test.tsx src/features/authFiles/hooks/useAuthFileQuotaRefresh.test.ts
```

Expected: all three test files pass.

- [ ] **Step 5: Commit page wiring**

```powershell
git add -- apps/web/src/features/authFiles/AuthFilesPage.quotaCooldown.test.tsx apps/web/src/features/authFiles/AuthFilesPage.tsx
git commit -m "fix(auth-files): refresh current-page quota"
```

---

### Task 4: Verify the complete auth-files quota-refresh surface

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: fresh evidence that the regression, adjacent auth-files behavior, types, and repository diff are clean.

- [ ] **Step 1: Run the focused regression suite**

```powershell
npm --workspace apps/web run test -- src/features/authFiles/hooks/useAuthFileQuotaRefresh.test.ts src/features/authFiles/components/AuthFileQuotaSection.test.tsx src/features/authFiles/AuthFilesPage.quotaCooldown.test.tsx
```

Expected: all focused files and tests pass with exit code `0`.

- [ ] **Step 2: Run the established auth-files proving lane**

```powershell
npm --workspace apps/web run test -- src/features/authFiles/AuthFilesPage.pasteIntegration.test.tsx src/features/authFiles/AuthFilesPage.quotaCooldown.test.tsx src/features/authFiles/model/authFilesPageModel.test.ts src/features/authFiles/components/AuthFileQuotaSection.test.tsx src/features/authFiles/hooks/useAuthFileQuotaRefresh.test.ts
```

Expected: all selected auth-files test files pass with exit code `0`.

- [ ] **Step 3: Run frontend type checking**

```powershell
npm --workspace apps/web run type-check
```

Expected: TypeScript exits `0` with no errors.

- [ ] **Step 4: Run the complete frontend test suite**

```powershell
npm test
```

Expected: all Vitest files and tests pass with exit code `0`. If Windows prints `The system cannot find the path specified.` after passing counts, use the exit code and Vitest totals as the authoritative result.

- [ ] **Step 5: Check the final diff and working tree**

```powershell
git diff --check
git status --short
git log -5 --oneline
```

Expected: `git diff --check` exits `0`; `git status --short` is empty; the design, plan, and three implementation commits are visible in the recent log.
