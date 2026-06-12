package model

const (
	AccountActionTypeDelete = "delete"
	AccountActionTypeReauth = "reauth"
	AccountActionTypeReview = "review"

	AccountActionStatusPending  = "pending"
	AccountActionStatusIgnored  = "ignored"
	AccountActionStatusResolved = "resolved"
	AccountActionStatusDeleted  = "deleted"
)

type AccountActionCandidate struct {
	ID                int64  `json:"id"`
	ActionType        string `json:"actionType"`
	Status            string `json:"status"`
	Provider          string `json:"provider,omitempty"`
	AuthFileName      string `json:"authFileName"`
	AuthIndex         string `json:"authIndex,omitempty"`
	AccountSnapshot   string `json:"accountSnapshot,omitempty"`
	AccountIDSnapshot string `json:"accountIdSnapshot,omitempty"`
	AuthLabel         string `json:"authLabel,omitempty"`
	Reason            string `json:"reason"`
	EvidenceJSON      string `json:"-"`
	Evidence          any    `json:"evidence,omitempty"`
	LastError         string `json:"lastError,omitempty"`
	FirstSeenAtMS     int64  `json:"firstSeenAtMs"`
	LastSeenAtMS      int64  `json:"lastSeenAtMs"`
	HitCount          int    `json:"hitCount"`
	CreatedAtMS       int64  `json:"createdAtMs"`
	UpdatedAtMS       int64  `json:"updatedAtMs"`
}

type AccountActionCandidateUpsert struct {
	ActionType        string
	Provider          string
	AuthFileName      string
	AuthIndex         string
	AccountSnapshot   string
	AccountIDSnapshot string
	AuthLabel         string
	Reason            string
	EvidenceJSON      string
	SeenAtMS          int64
}
