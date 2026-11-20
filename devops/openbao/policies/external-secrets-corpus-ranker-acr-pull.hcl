# OpenBao policy for the estate External Secrets role: the ranker's own
# pull-only ACR token corpus-ranker-pull (repository corpus-ranker on
# noncelogicci.azurecr.io), one exact path, read-only. No list, no metadata,
# no wildcard, no other path (Rule: policies/placement-defaults.yaml#credentials:
# per product, pull-only, custodied under the product's path; #estate secrets).
# Created estate-side and attached to the Kubernetes auth role eso-obs on
# 2026-11-19 (meta-harness devops/aks/corpus-ranker-argo/README.md "Moved to
# ACR"); this file is its reviewed source (Rule: #code_location). Its only
# reader in this product is the ExternalSecret `ranker-registry-pull` in
# deploy/externalsecrets.yaml. tests/deploy/registry-pull-grant.test.ts loads
# it alone into a throwaway OpenBao.
path "kv/data/corpus-ranker/acr-pull" {
  capabilities = ["read"]
}
