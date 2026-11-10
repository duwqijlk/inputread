"""Build immutable per-lemma OEWN JSON from a pinned, clean dictionary checkout.

Usage: python -I scripts/build-oewn-r2.py --repo PATH --out NEW_DIRECTORY
Requires PyYAML. Never uploads, modifies the source, or changes live books.
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument('--repo', type=Path, required=True)
    args.add_argument('--out', type=Path, required=True)
    opts = args.parse_args()
    repo = opts.repo.resolve()
    out = opts.out.resolve()
    if out.exists() or not out.parent.is_dir() or out.is_relative_to(repo):
        raise ValueError('Choose a new output directory outside the dictionary source')
    helper = repo / 'scripts/learning_gloss_format.py'
    spec = importlib.util.spec_from_file_location('verified_learning_gloss_format', helper)
    if spec is None or spec.loader is None:
        raise ValueError('Missing dictionary source validation helper')
    fmt = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fmt)
    config, paths, notices = fmt.verify_source(repo)
    commit = fmt.git(repo, 'rev-parse', '--verify', 'HEAD^{commit}').decode().strip()
    scope = ('LEARNING_SOURCE.json', 'src/yaml', 'src/learning-glosses', 'LICENSE.md', 'WNDB_License.txt', 'scripts')
    status = fmt.git(repo, 'status', '--porcelain', '-z', '--untracked-files=all', '--', *scope)
    unexpected = [item for item in status.split(b'\0') if item and not (item[:2] in (b'??', b'!!') and b'__pycache__' in item)]
    if unexpected:
        raise ValueError('Dictionary source and tooling must be a clean committed snapshot')
    synsets, entries, source_senses = fmt.source_index(paths)
    overlays = fmt.learning_records(repo / 'src/learning-glosses', source_senses, synsets, config['recordSchema'])
    if len(source_senses) != 185129:
        raise ValueError(f'Unexpected source sense count: {len(source_senses)}')
    if not set(overlays) <= set(source_senses):
        raise ValueError('Unbound learning sense')
    release = 'oewn-2025-' + commit[:12]
    root = out / 'dictionary/releases' / release
    words = root / 'words'
    words.mkdir(parents=True)
    totals = Counter()
    sizes: list[int] = []
    seen_ids: set[str] = set()
    manifest_rows = []
    def encode(value: object) -> bytes:
        return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf8')
    for lemma, groups in sorted(entries.items()):
        sense_rows = []
        for lexical_key, entry in groups.items():
            pos = lexical_key[0]
            for sense in entry.get('sense', []):
                sid = sense['id']
                if sid in seen_ids:
                    raise ValueError('Duplicate sense: ' + sid)
                seen_ids.add(sid)
                synset_id = sense['synset']
                original = '; '.join(synsets[synset_id]['definition'])
                overlay = overlays.get(sid)
                meaning = overlay['simpleMeaning'] if overlay else original
                sense_rows.append({'id': sid, 'pos': pos, 'meaning': meaning,
                                   'originalMeaning': original,
                                   **({'learningMeaning': overlay['simpleMeaning']} if overlay else {})})
                totals['learning' if overlay else 'original'] += 1
        if not sense_rows:
            raise ValueError('Entry has no senses: ' + lemma)
        # Exact original lemma is a data key; hex prevents path separators and percent decoding.
        hex_key = lemma.encode('utf8').hex()
        relative = Path('words') / hex_key[:2] / (hex_key + '.json')
        dest = root / relative
        dest.parent.mkdir(exist_ok=True)
        body = encode({'schema': 'oewn-r2-entry-v1', 'release': release,
                       'lookupKey': lemma, 'senses': sense_rows})
        dest.write_bytes(body)
        sizes.append(len(body))
        manifest_rows.append((lemma, relative.as_posix(), sha256(body).hexdigest()))
    if seen_ids != set(source_senses):
        raise ValueError(f'Sense inventory mismatch: {len(seen_ids)} != {len(source_senses)}')
    if totals['learning'] != len(overlays):
        raise ValueError('Overlay count mismatch')
    for filename, text, _ in notices:
        (root / filename).write_text(text, encoding='utf8')
    digest = sha256()
    for lemma, relative, file_hash in manifest_rows:
        digest.update(encode([lemma, relative, file_hash]))
    manifest = {'schema': 'oewn-r2-manifest-v1', 'release': release,
                'sourceCommit': config['sourceCommit'], 'learningCommit': commit,
                'senseCount': len(seen_ids), 'wordCount': len(manifest_rows),
                'learningCount': totals['learning'], 'originalCount': totals['original'],
                'inventorySha256': digest.hexdigest(), 'licenseFiles': [name for name, _, _ in notices],
                'studentValidated': False}
    (root / 'manifest.json').write_bytes(encode(manifest))
    # current.json is a separate publish switch, not included in immutable release uploads.
    (out / 'dictionary/current.json').write_bytes(encode({'schema': 'oewn-r2-current-v1', 'release': release}))
    report = {**manifest, 'bytes': sum(sizes), 'maxBytes': max(sizes),
              'p50Bytes': sorted(sizes)[len(sizes) // 2],
              'p95Bytes': sorted(sizes)[int(len(sizes) * .95)],
              'p99Bytes': sorted(sizes)[int(len(sizes) * .99)],
              'status': 'built-not-uploaded'}
    (out / 'BUILD-REPORT.json').write_bytes(encode(report))
    if fmt.git(repo, 'rev-parse', '--verify', 'HEAD^{commit}').decode().strip() != commit:
        raise ValueError('Source HEAD changed during build')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
