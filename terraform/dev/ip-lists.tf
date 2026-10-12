# A private IP list read from S3 (s3:// URL in ip_lists): the scanning ranges Censys publishes for opt-out
# (https://docs.censys.com/docs/opt-out-of-data-collection, 2026-10-04). Its scanners are already ignored by user agent;
# the list also catches them when the user agent is generic.

locals {
  ip_lists_bucket = "${local.name}-ip-lists-${var.account_id}"
}

resource "aws_s3_bucket" "ip_lists" {
  bucket        = local.ip_lists_bucket
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "ip_lists" {
  bucket                  = aws_s3_bucket.ip_lists.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "ip_lists" {
  bucket = aws_s3_bucket.ip_lists.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_object" "censys" {
  bucket       = aws_s3_bucket.ip_lists.id
  key          = "scanners/censys.txt"
  content_type = "text/plain"
  content = join("\n", concat(["# Censys scanning ranges (docs.censys.com, opt-out of data collection)"], [
    "162.142.125.0/24", "167.94.138.0/24", "167.94.145.0/24", "167.94.146.0/24", "167.248.133.0/24",
    "199.45.154.0/24", "199.45.155.0/24", "206.168.34.0/24", "206.168.35.0/24",
    "66.132.148.0/24", "66.132.153.0/24", "66.132.159.0/24", "66.132.172.0/24", "66.132.186.0/24", "66.132.195.0/24", "66.132.224.0/24",
    "2602:80d:1000:b0cc:e::/80", "2602:80d:1003::/112", "2602:80d:1004::/112", "2620:96:e000:b0cc:e::/80",
  ], [""]))
}
