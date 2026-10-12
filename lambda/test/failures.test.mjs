import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, classifyText } from '../src/lib/failures.mjs';

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
