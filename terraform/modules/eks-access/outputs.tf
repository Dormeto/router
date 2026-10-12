output "router_access_entries" {
  description = "The access entries of the router's roles, by role ARN."
  value       = { for arn, entry in aws_eks_access_entry.router : arn => entry.access_entry_arn }
}

output "discovery_access_entry" {
  description = "The access entry of DmtDiscoveryRole, null without it."
  value       = one(aws_eks_access_entry.discovery[*].access_entry_arn)
}
