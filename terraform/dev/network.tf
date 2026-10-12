data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "demo" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = "${local.name}-demo" }
}

resource "aws_internet_gateway" "demo" {
  vpc_id = aws_vpc.demo.id
  tags   = { Name = "${local.name}-demo" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.demo.id
  cidr_block              = cidrsubnet(aws_vpc.demo.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-demo-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.demo.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.demo.id
  }
  tags = { Name = "${local.name}-demo-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
