package accountaction_test

import (
	"context"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

func TestUpsertMergesPendingCandidateByAuthFileAndAction(t *testing.T) {
	ctx := context.Background()
	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)
	repo := st.AccountActions

	first, err := repo.Upsert(ctx, model.AccountActionCandidateUpsert{
		ActionType:      model.AccountActionTypeDelete,
		Provider:        "codex",
		AuthFileName:    "codex-auth.json",
		AuthIndex:       "3",
		AccountSnapshot: "user@example.com",
		AuthLabel:       "User",
		Reason:          "token revoked",
		EvidenceJSON:    `{"code":"token_revoked"}`,
		SeenAtMS:        1000,
	})
	if err != nil {
		t.Fatalf("upsert first: %v", err)
	}
	if first.ID == 0 || first.HitCount != 1 || first.Status != model.AccountActionStatusPending {
		t.Fatalf("first candidate = %#v", first)
	}

	second, err := repo.Upsert(ctx, model.AccountActionCandidateUpsert{
		ActionType:      model.AccountActionTypeDelete,
		Provider:        "codex",
		AuthFileName:    "codex-auth.json",
		AuthIndex:       "3",
		AccountSnapshot: "user@example.com",
		Reason:          "token revoked again",
		EvidenceJSON:    `{"code":"token_revoked","hit":2}`,
		SeenAtMS:        2000,
	})
	if err != nil {
		t.Fatalf("upsert second: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("second ID = %d, want %d", second.ID, first.ID)
	}
	if second.HitCount != 2 || second.LastSeenAtMS != 2000 || second.Reason != "token revoked again" {
		t.Fatalf("second candidate = %#v", second)
	}

	pending, err := repo.List(ctx, model.AccountActionStatusPending, 10)
	if err != nil {
		t.Fatalf("list pending: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("pending count = %d", len(pending))
	}
	count, err := repo.Count(ctx, model.AccountActionStatusPending)
	if err != nil {
		t.Fatalf("count pending: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d", count)
	}

	ignored, err := repo.UpdateStatus(ctx, first.ID, model.AccountActionStatusIgnored)
	if err != nil {
		t.Fatalf("ignore: %v", err)
	}
	if ignored.Status != model.AccountActionStatusIgnored {
		t.Fatalf("ignored status = %q", ignored.Status)
	}

	third, err := repo.Upsert(ctx, model.AccountActionCandidateUpsert{
		ActionType:   model.AccountActionTypeDelete,
		AuthFileName: "codex-auth.json",
		Reason:       "new pending after ignored",
		SeenAtMS:     3000,
	})
	if err != nil {
		t.Fatalf("upsert third: %v", err)
	}
	if third.ID == first.ID || third.HitCount != 1 || third.Status != model.AccountActionStatusPending {
		t.Fatalf("third candidate = %#v", third)
	}
}
