# OpenBao policy for the API key Job (deploy/api-keys-job.yaml), held only by
# the Kubernetes auth role corpus-ranker-api-keys
# (devops/openbao/kubernetes-roles/corpus-ranker-api-keys.json).
#
# The CR-M3-DEC-KEYGEN-GRANT default, after the estate's credential_writeback
# rule (Rule: policies/placement-defaults.yaml#estate): a Job generating a
# product's own credentials gets that one product data path only. The Job
# writes the key set once, check-and-set 0 (`create`, which OpenBao allows only
# while the path holds no secret), and on later syncs checks the set is there
# (`read`). No update or patch (an existing key set stays untouched), no
# delete, no list, no metadata, no other path.
# tests/deploy/api-keys-job.test.ts holds this.
path "kv/data/corpus-ranker/api-keys" {
  capabilities = ["create", "read"]
}
