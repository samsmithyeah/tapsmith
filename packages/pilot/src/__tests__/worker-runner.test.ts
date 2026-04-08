import { describe, it, expect } from 'vitest';
import { isRecoverableInfrastructureError } from '../worker-protocol.js';

describe('isRecoverableInfrastructureError', () => {
  it('returns true for agent timeout errors', () => {
    expect(isRecoverableInfrastructureError(new Error('Agent command timed out after 30000ms'))).toBe(true);
  });

  it('returns true for empty response errors', () => {
    expect(isRecoverableInfrastructureError(new Error('Agent returned empty response'))).toBe(true);
  });

  it('returns true for agent disconnection errors', () => {
    expect(isRecoverableInfrastructureError(new Error('Not connected to agent'))).toBe(true);
  });

  it('returns true for socket connection timeout', () => {
    expect(isRecoverableInfrastructureError(new Error('Timed out connecting to agent socket'))).toBe(true);
  });

  it('returns true for socket connection failure', () => {
    expect(isRecoverableInfrastructureError(new Error('Failed to connect to agent socket on port 18700'))).toBe(true);
  });

  it('returns true for gRPC UNAVAILABLE errors', () => {
    expect(isRecoverableInfrastructureError(new Error('14 UNAVAILABLE: No connection established'))).toBe(true);
  });

  it('returns true for gRPC DEADLINE_EXCEEDED errors (agent/daemon hung)', () => {
    expect(isRecoverableInfrastructureError(new Error('4 DEADLINE_EXCEEDED: Deadline exceeded'))).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isRecoverableInfrastructureError(new Error('connect ECONNREFUSED 127.0.0.1:50051'))).toBe(true);
  });

  it('returns false for assertion errors', () => {
    expect(isRecoverableInfrastructureError(new Error('Expected "Login" to be visible'))).toBe(false);
  });

  it('returns false for test timeout errors (these are real test failures)', () => {
    expect(isRecoverableInfrastructureError(new Error('Test timed out after 60000ms'))).toBe(false);
  });

  it('returns false for generic errors', () => {
    expect(isRecoverableInfrastructureError(new Error('something went wrong'))).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isRecoverableInfrastructureError('Agent command timed out')).toBe(true);
    expect(isRecoverableInfrastructureError('random string')).toBe(false);
    expect(isRecoverableInfrastructureError(42)).toBe(false);
    expect(isRecoverableInfrastructureError(null)).toBe(false);
  });
});
