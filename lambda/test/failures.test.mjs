import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, classify, classifyText } from '../src/lib/failures.mjs';

const aws = (name, message) => Object.assign(new Error(message), { name });

test('classifies the AWS errors of a start by kind, keeping their message', () => {
  const cases = [
    [aws('InsufficientInstanceCapacity', 'We currently do not have sufficient t3.medium capacity in the Availability Zone you requested (eu-west-1b).'), 'capacity'],
    [aws('InsufficientDBInstanceCapacity', 'Cannot start the DB instance dmt-dev-demo-rds because there is no capacity for your instance class db.t4g.micro in AZ eu-west-1b.'), 'capacity'],
    [aws('InsufficientDBClusterCapacity', 'no capacity'), 'capacity'],
    [aws('VcpuLimitExceeded', 'You have requested more vCPU capacity than your current vCPU limit of 32 allows'), 'quota'],
    [aws('InstanceLimitExceeded', 'limit'), 'quota'],
    [aws('UnauthorizedOperation', 'You are not authorized to perform this operation.'), 'permission'],
    [aws('AccessDeniedException', 'User is not authorized to perform: ecs:UpdateService'), 'permission'],
    [aws('InvalidParameterValue', 'bad parameter'), 'configuration'],
    [aws('Unsupported', 'The requested configuration is currently not supported.'), 'configuration'],
    [aws('IncorrectInstanceState', 'The instance is not in a state from which it can be started.'), 'configuration'],
    [aws('ThrottlingException', 'Rate exceeded'), 'throttled'],
    [aws('RequestLimitExceeded', 'Request limit exceeded.'), 'throttled'],
    [new Error('wake timeout: no healthy target'), 'timeout'],
    [aws('SomethingNew', 'never seen'), 'unknown'],
  ];
  for (const [error, kind] of cases) assert.equal(classify(error).kind, kind, `${error.name}: ${error.message}`);
  assert.deepEqual(classify(aws('SomethingNew', 'never seen')), { kind: 'unknown', message: 'SomethingNew: never seen' });
  assert.equal(classify(aws('InsufficientInstanceCapacity', 'x'.repeat(400))).message.length, 300);
});

test('classifies the texts of Auto Scaling activities and ECS service events', () => {
  assert.equal(classifyText('We currently do not have sufficient t3.micro capacity in zones with support for \'gp3\' volumes. Our system will be working on provisioning additional capacity.'), 'capacity');
  assert.equal(classifyText('service dmt-dev-demo was unable to place a task because no container instance met all of its requirements.'), 'capacity');
  assert.equal(classifyText('Capacity is unavailable at this time. Please try again later or in a different availability zone'), 'capacity');
  assert.equal(classifyText('You have requested more vCPU capacity than your current vCPU limit of 8 allows for the instance bucket'), 'quota');
  assert.equal(classifyText('The specified launch template, with template ID lt-0123, does not exist.'), 'configuration');
  assert.equal(classifyText('Client.UnauthorizedOperation: You are not authorized to use launch template'), 'permission');
  assert.equal(classifyText('Something else entirely'), 'unknown');
});

// Kubernetes workloads (vision docs/specs/2026-10-11-kubernetes-design.md, section 7): the cluster API's answers by kind.
const kube = (status, reason, message) => Object.assign(new Error(message), { name: 'KubernetesError', status, reason });

test('classifies the errors of a cluster: refused rights are permission, an unreachable or failing cluster is the new kind cluster', () => {
  assert.ok(KINDS.includes('cluster'));
  const cases = [
    [kube(401, 'Unauthorized', 'Unauthorized'), 'permission'],
    [kube(403, 'Forbidden', 'deployments.apps "web" is forbidden: User "arn:aws:sts::1:assumed-role/dmt-dev-controller/x" cannot patch resource "deployments/scale"'), 'permission'],
    [kube(0, 'Timeout', 'GET /apis/apps/v1/namespaces/demo/deployments/web: no connection within 3000 ms'), 'cluster'],
    [kube(0, 'ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443'), 'cluster'],
    [kube(0, 'ENOTFOUND', 'getaddrinfo ENOTFOUND abc.gr7.eu-west-1.eks.amazonaws.com'), 'cluster'],
    [kube(0, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'), 'cluster'],
    [kube(500, 'InternalError', 'etcdserver: request timed out'), 'cluster'],
    [kube(503, 'ServiceUnavailable', 'the server is currently unable to handle the request'), 'cluster'],
    [kube(429, 'TooManyRequests', 'too many requests'), 'throttled'],
    [kube(404, 'NotFound', 'deployments.apps "web" not found'), 'configuration'],
    [kube(422, 'Invalid', 'Ingress.networking.k8s.io "dormeto-demo" is invalid'), 'configuration'],
  ];
  for (const [error, kind] of cases) assert.equal(classify(error).kind, kind, `${error.status} ${error.reason}`);
  assert.deepEqual(classify(kube(503, 'ServiceUnavailable', 'the server is currently unable to handle the request')), { kind: 'cluster', message: 'the server is currently unable to handle the request' });
});
