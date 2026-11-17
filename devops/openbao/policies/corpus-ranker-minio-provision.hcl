# OpenBao policy for the MinIO provisioning Job (deploy/minio-provision-job.yaml),
# held only by the Kubernetes auth role corpus-ranker-minio-provision
# (devops/openbao/kubernetes-roles/corpus-ranker-minio-provision.json).
#
# CRANK-140, and the estate's credential_writeback rule (placement-defaults
# estate.credential_writeback): a Job generating a product's own credentials
# gets read and patch on that one product data path only. The Job reads the
# published record (`bao kv get`) and patches the ranker service user's
# credentials into it (`bao kv patch`), keeping the estate's root credentials.
# No create/update (a put would drop the root credentials), no delete, no list,
# no metadata, no other path. tests/deploy/minio-provision-job.test.ts holds this.
path "kv/data/corpus-ranker/minio" {
  capabilities = ["read", "patch"]
}
