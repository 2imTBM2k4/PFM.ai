import { describe, expect, it, vi } from 'vitest';
import {
  getCameraClearance,
  isDuoClosedPortraitViewport,
} from './responsive-layout';

vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

describe('responsive layout', () => {
  it('detects a closed Duo in portrait', () => {
    expect(isDuoClosedPortraitViewport(540, 720)).toBe(true);
    expect(isDuoClosedPortraitViewport(720, 1280)).toBe(true);
  });

  it('keeps the bottom navigation when a closed Duo rotates', () => {
    expect(isDuoClosedPortraitViewport(720, 540)).toBe(false);
    expect(isDuoClosedPortraitViewport(844, 390)).toBe(false);
  });

  it('keeps the bottom navigation on iPhones and when the Duo opens wider', () => {
    expect(isDuoClosedPortraitViewport(402, 874)).toBe(false);
    expect(isDuoClosedPortraitViewport(430, 932)).toBe(false);
    expect(isDuoClosedPortraitViewport(1114, 720)).toBe(false);
    expect(isDuoClosedPortraitViewport(780, 844)).toBe(false);
  });

  it('adds camera clearance only when a modern portrait preview has no native inset', () => {
    expect(getCameraClearance(402, 874, 0)).toBe(52);
    expect(getCameraClearance(430, 932, 0)).toBe(52);
    expect(getCameraClearance(540, 720, 0)).toBe(52);
    expect(getCameraClearance(402, 874, 59)).toBe(0);
    expect(getCameraClearance(874, 402, 0)).toBe(0);
    expect(getCameraClearance(768, 1024, 0)).toBe(0);
  });
});
