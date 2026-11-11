import { z } from 'zod';
import * as Y from 'yjs';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  coordinate = z.number().finite().min(-1e7).max(1e7);
const color = z.string().regex(/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/);
const point = z.tuple([coordinate, coordinate]);
const element = z
  .object({
    id,
    type: z.enum([
      'rectangle',
      'diamond',
      'ellipse',
      'line',
      'arrow',
      'freedraw',
      'text',
      'frame',
      'image',
    ]),
    x: coordinate,
    y: coordinate,
    width: z.number().finite().min(0).max(1e7),
    height: z.number().finite().min(0).max(1e7),
    angle: coordinate,
    strokeColor: color,
    backgroundColor: color,
    fillStyle: z.enum(['hachure', 'cross-hatch', 'solid', 'zigzag']),
    strokeWidth: z.number().finite().min(0).max(100),
    strokeStyle: z.enum(['solid', 'dashed', 'dotted']),
    roughness: z.number().finite().min(0).max(10),
    opacity: z.number().finite().min(0).max(100),
    groupIds: z.array(id).max(32),
    frameId: id.nullable(),
    roundness: z
      .object({
        type: z.number().int().min(1).max(3),
        value: z.number().finite().min(0).max(1e7).optional(),
      })
      .strict()
      .nullable(),
    seed: z.number().int(),
    version: z.number().int().min(1).max(2147483647),
    versionNonce: z.number().int(),
    isDeleted: z.boolean(),
    boundElements: z
      .array(z.object({ id, type: z.enum(['arrow', 'text']) }).strict())
      .max(500)
      .nullable(),
    updated: z.number().finite().min(0),
    link: z
      .string()
      .max(2048)
      .refine((v) => {
        try {
          return ['http:', 'https:', 'mailto:'].includes(new URL(v).protocol);
        } catch {
          return false;
        }
      })
      .nullable(),
    locked: z.boolean(),
    index: z.string().max(128).nullable().optional(),
    points: z.array(point).max(5000).optional(),
    pressures: z.array(z.number().finite().min(0).max(1)).max(5000).optional(),
    text: z.string().max(10000).optional(),
    originalText: z.string().max(10000).optional(),
  })
  .passthrough();

function safeJson(value: unknown, depth = 0): void {
  if (depth > 10) throw new Error('Board object nesting limit');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 10000) throw new Error('Board array limit');
    for (const item of value) safeJson(item, depth + 1);
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 100) throw new Error('Board object property limit');
    for (const [key, item] of entries) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('Unsafe board property');
      safeJson(item, depth + 1);
    }
    return;
  }
  throw new Error('Board values must be finite JSON');
}
/** Validate on the server; the editor's read-only UI is not authorization. */
export function validateBoard(doc: Y.Doc) {
  if ([...doc.share.keys()].some((key) => key !== 'elements' && key !== 'settings'))
    throw new Error('Unknown board root');
  const settings = doc.getMap('settings');
  if ([...settings.keys()].some((key) => !['backgroundColor', 'measurement'].includes(key)))
    throw new Error('Unknown board setting');
  if (settings.has('backgroundColor')) color.parse(settings.get('backgroundColor'));
  if (settings.has('measurement'))
    z.object({
      pixelsPerUnit: z.number().finite().positive().max(1e9),
      unit: z.enum(['px', 'mm', 'cm', 'm', 'in', 'ft']),
    })
      .strict()
      .parse(settings.get('measurement'));
  const elements = doc.getMap('elements');
  if (elements.size > 5000) throw new Error('Board object limit');
  let points = 0,
    text = 0;
  for (const [key, value] of elements) {
    const parsed = element.parse(value);
    if (parsed.id !== key) throw new Error('Board object identity mismatch');
    safeJson(value);
    points += parsed.points?.length ?? 0;
    text += parsed.text?.length ?? 0;
    if (points > 100000 || text > 200000) throw new Error('Board content limit');
    if (
      parsed.type === 'freedraw' &&
      (value as { simulatePressure?: unknown }).simulatePressure === false
    ) {
      const ink = value as { simulatePressure?: unknown; pressures?: number[]; points?: unknown[] };
      if (
        ink.simulatePressure !== false ||
        !ink.pressures ||
        !ink.points ||
        ink.pressures.length !== ink.points.length
      )
        throw new Error('Invalid pressure samples');
    }
    if (parsed.type === 'text') {
      const v = value as Record<string, unknown>;
      z.object({
        fontSize: z.number().finite().min(1).max(1000),
        fontFamily: z.number().int().min(1).max(20),
        textAlign: z.enum(['left', 'center', 'right']),
        verticalAlign: z.enum(['top', 'middle', 'bottom']),
        containerId: id.nullable(),
        autoResize: z.boolean(),
        lineHeight: z.number().finite().min(0.5).max(10),
      })
        .passthrough()
        .parse(v);
    }
    if (parsed.type === 'image')
      z.object({
        fileId: z.uuid(),
        status: z.literal('saved'),
        scale: z.tuple([
          z.union([z.literal(-1), z.literal(1)]),
          z.union([z.literal(-1), z.literal(1)]),
        ]),
      })
        .passthrough()
        .parse(value);
  }
  if (Y.encodeStateAsUpdate(doc).length > 2500000) throw new Error('Board state size limit');
}
