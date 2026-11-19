# OpenBao policy for the estate External Secrets role (CRANK-140): the ranker's
# MinIO credentials, one exact path, read-only. No list, no metadata, no
# wildcard, no other path (Rule: policies/placement-defaults.yaml#estate
# secrets). One policy per custody path: the API key set is granted by
# external-secrets-corpus-ranker.hcl. Both are attached estate-side, add-only,
# to the Kubernetes auth role eso-obs the `openbao` ClusterSecretStore logs in
# with (devops/openbao/kubernetes-roles/eso-obs.attach.json), beside
# the estate-held ACR pull grant (kv/corpus-ranker/acr-pull); this one's readers in this product are the
# ExternalSecrets `ranker-minio` and `ranker-minio-service`
# (kv/corpus-ranker/minio, written by the ranker-minio-provision Job) in
# deploy/externalsecrets.yaml.
# tests/deploy/external-secrets.test.ts loads it alone into a throwaway OpenBao.
path "kv/data/corpus-ranker/minio" {
  capabilities = ["read"]
}
