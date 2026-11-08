# gcp-releases

Dormeto's own release project, `dormeto-releases`: the three public Artifact Registry repositories `router` in
`europe`, `us` and `asia` (Docker, immutable tags), which hold the router image
`<europe|us|asia>-docker.pkg.dev/dormeto-releases/router/router:<version>`. `scripts/gcp-image.sh` pushes to them at a
release.

- Applied only at a release, on the user's word: `tfenv exec terraform plan -out`, read it, then apply the saved plan.
  The state is in S3 (`router/gcp-releases.tfstate`).
- The `allUsers` `roles/artifactregistry.reader` binding on each repository makes the image public. It is the one IAM
  change of the router's Terraform outside `dormeto gcp install`; `terraform/gcp-dev` still holds none.
