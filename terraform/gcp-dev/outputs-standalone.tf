# The standalone demo VM's output, apart from outputs.tf: null at the defaults (enable_standalone off).
output "standalone" {
  description = "The standalone demo VM's resource path (projects/<p>/zones/<z>/instances/<n>), for dormeto gcp workloads onboard --resource; null unless enable_standalone."
  value       = var.enable_standalone ? google_compute_instance.standalone[0].id : null
}
