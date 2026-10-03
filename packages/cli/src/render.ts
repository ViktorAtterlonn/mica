import type { SchemaChange, SchemaDiff } from '@mica/db/tooling';

const riskWarnings: [SchemaChange['risks'][number], string][] = [
  ['existing-data', 'Existing data may conflict. No data is scanned or migrated.'],
  ['index-rebuild', 'Drops before rebuilding; failure can leave the index absent.'],
  ['index-drop', 'Removing an index can affect query performance and uniqueness enforcement.'],
  ['ttl-deletion', 'MongoDB TTL may delete existing documents after deployment.'],
];

function describeChange(change: SchemaChange): string {
  switch (change.kind) {
    case 'collection-added':
      return '+ create missing collection';
    case 'validator-added':
      return '+ add validator';
    case 'validator-removed':
      return '- remove validator';
    case 'validator-changed':
      return '~ update validator';
    case 'index-added':
      return `+ create index ${change.after.name}`;
    case 'index-removed':
      return `- remove index ${change.before.name}`;
    case 'index-changed':
      return `~ recreate index ${change.after.name}`;
    case 'unsupported':
      return `! ${change.side} ${change.issue.scope}: ${change.issue.code} at ${change.issue.path.join('.') || '(root)'}`;
  }
}

function renderChangeDetails(change: SchemaChange): string[] {
  switch (change.kind) {
    case 'collection-added':
      return [];
    case 'unsupported':
      return [
        `      configuration ${change.issue.source}`,
        '      Mica cannot safely compare this configuration; push is blocked.',
      ];
    case 'validator-added':
    case 'validator-removed':
    case 'validator-changed':
      return change.details.flatMap((detail) => [
        `      ${detail.path.join('.')}`,
        `        database  ${'before' in detail ? JSON.stringify(detail.before) : '(absent)'}`,
        `        code      ${'after' in detail ? JSON.stringify(detail.after) : '(absent)'}`,
      ]);
    case 'index-added':
      return [`      code      ${JSON.stringify(change.after)}`];
    case 'index-removed':
      return [`      database  ${JSON.stringify(change.before)}`];
    case 'index-changed':
      return [
        `      database  ${JSON.stringify(change.before)}`,
        `      code      ${JSON.stringify(change.after)}`,
      ];
  }
}

export function renderCheck(diff: SchemaDiff): string {
  if (!diff.changes.length) return 'Schema is synchronized.';
  const count = diff.changes.length;
  return `Schema drift detected: ${count} difference${count === 1 ? '' : 's'}. Run mica diff for details.`;
}

export function renderDiff(diff: SchemaDiff, command: 'diff' | 'push'): string {
  const lines = [`Mica schema ${command}`, ''];
  for (const collection of diff.desired.collections) {
    lines.push(collection.name);
    const changes = diff.changes.filter((change) => change.collection === collection.name);
    if (!changes.length)
      lines.push(`  ✓ validator and ${collection.indexes.length} declared indexes match`);

    for (const change of changes) {
      lines.push(`  ${describeChange(change)}`);
      lines.push(...renderChangeDetails(change));
      for (const [risk, warning] of riskWarnings) {
        if (change.risks.includes(risk)) lines.push(`      ! ${warning}`);
      }
    }

    const unmanaged = diff.unmanagedIndexes.filter((entry) => entry.collection === collection.name);
    for (const { index } of unmanaged) lines.push(`  · preserve unmanaged index ${index.name}`);
    lines.push('');
  }
  lines.push(`${diff.changes.length} difference${diff.changes.length === 1 ? '' : 's'} found`);
  if (command === 'push' && diff.changes.length)
    lines.push(
      'Index builds may take time and affect database load. Operations are not transactional.',
    );
  return lines.join('\n');
}
