# OpenBao policy for the estate External Secrets role (CRANK-140): the
# ranker's pull-only GHCR credential, one exact path, read-only. No list, no
# metadata, no wildcard, no other path (Rule: policies/placement-defaults.yaml#estate
# secrets). Attached estate-side to the role the `openbao` ClusterSecretStore
# logs in with; the ExternalSecret `ranker-ghcr-pull` (deploy/externalsecrets.yaml)
# is its only reader in this product.
path "kv/data/corpus-ranker/ghcr-pull" {
  capabilities = ["read"]
}
