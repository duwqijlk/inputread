"""Build an immutable explicit OEWN form index; never infer regular inflections.

Usage: python -I scripts/build-dictionary-form-index.py --source GIT_REPO \
    --release RELEASE_ROOT --out NEW_DIRECTORY
Requires PyYAML and Node (for exactly the reader's NFC/toLowerCase semantics).
Only the new output directory is written. No publish switch is generated.
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unicodedata

import yaml


class UniqueLoader(getattr(yaml, 'CSafeLoader', yaml.SafeLoader)):
    """Reject duplicate keys rather than silently replacing source records."""


def mapping(loader, node):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=True)
        if key in result:
            raise ValueError('Duplicate YAML key: ' + str(key))
        result[key] = loader.construct_object(value_node, deep=True)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf8')


def regular_file(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Not a regular file: ' + str(path))
    return path.read_bytes()


def directory(path):
    if path.is_symlink() or not path.is_dir():
        raise ValueError('Not a regular directory: ' + str(path))


def git(source, *args, data=None):
    result = subprocess.run(
        ['git', '--no-replace-objects', '-C', str(source), *args], input=data,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={**os.environ, 'GIT_NO_LAZY_FETCH': '1', 'GIT_TERMINAL_PROMPT': '0'})
    if result.returncode:
        raise ValueError('Cannot verify Git source: ' + result.stderr.decode('utf8', 'replace'))
    return result.stdout


def text(value):
    return isinstance(value, str) and bool(value) and not any(0xd800 <= ord(c) <= 0xdfff for c in value)


def read_release(root):
    directory(root)
    manifest = json.loads(regular_file(root / 'manifest.json'))
    if (manifest.get('schema') != 'oewn-r2-manifest-v1'
            or not re.fullmatch(r'oewn-[a-zA-Z0-9-]+', manifest.get('release', ''))
            or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('learningCommit', ''))
            or not re.fullmatch(r'[0-9a-f]{64}', manifest.get('inventorySha256', ''))
            or any(type(manifest.get(k)) is not int or manifest[k] < 1 for k in ('wordCount', 'senseCount'))):
        raise ValueError('Invalid release manifest')
    words = root / 'words'
    directory(words)
    entries, seen_senses, rows = {}, set(), []
    for bucket in sorted(words.iterdir()):
        if not re.fullmatch(r'[0-9a-f]{2}', bucket.name):
            raise ValueError('Invalid release bucket')
        directory(bucket)
        for path in sorted(bucket.iterdir()):
            if not re.fullmatch(r'(?:[0-9a-f]{2})+\.json', path.name):
                raise ValueError('Invalid release entry path')
            body = regular_file(path)
            entry = json.loads(body)
            lemma = entry.get('lookupKey')
            if (entry.get('schema') != 'oewn-r2-entry-v1' or entry.get('release') != manifest['release']
                    or not text(lemma) or lemma != unicodedata.normalize('NFC', lemma)
                    or lemma in entries or not isinstance(entry.get('senses'), list) or not entry['senses']):
                raise ValueError('Invalid release entry identity')
            hex_key = lemma.encode('utf8').hex()
            relative = path.relative_to(root).as_posix()
            if relative != f'words/{hex_key[:2]}/{hex_key}.json':
                raise ValueError('Release entry identity path mismatch')
            bindings = set()
            for sense in entry['senses']:
                sid, pos = sense.get('id'), sense.get('pos')
                if not text(sid) or sid in seen_senses or pos not in ('n', 'v', 'a', 's', 'r'):
                    raise ValueError('Invalid/duplicate release sense binding')
                seen_senses.add(sid)
                bindings.add((sid, pos))
            entries[lemma] = bindings
            rows.append((lemma, relative, sha256(body).hexdigest()))
    if len(entries) != manifest['wordCount'] or len(seen_senses) != manifest['senseCount']:
        raise ValueError('Release wordCount/senseCount mismatch')
    digest = sha256()
    for row in sorted(rows):
        digest.update(encode(row))
    if digest.hexdigest() != manifest['inventorySha256']:
        raise ValueError('Release inventory SHA256 mismatch')
    return manifest, entries


def verify_source(source, commit):
    if git(source, 'rev-parse', '--verify', 'HEAD^{commit}').decode().strip() != commit:
        raise ValueError('Source HEAD must match release learningCommit')
    if git(source, 'status', '--porcelain', '-z', '--untracked-files=all', '--', 'src/yaml'):
        raise ValueError('Source src/yaml must be clean')
    directory(source / 'src')
    base = source / 'src/yaml'
    directory(base)
    blobs = {}
    for item in git(source, 'ls-tree', '-rz', commit, '--', 'src/yaml').split(b'\0'):
        if not item:
            continue
        header, name = item.split(b'\t', 1)
        mode, kind, oid = header.split()
        name = name.decode('utf8')
        if (mode not in (b'100644', b'100755') or kind != b'blob'
                or Path(name).parent.as_posix() != 'src/yaml' or not name.endswith('.yaml')):
            raise ValueError('Invalid pinned source member: ' + name)
        blobs[name] = oid
    actual = set()
    for path in base.rglob('*'):
        if path.is_symlink():
            raise ValueError('Unsafe source member')
        if path.is_file():
            actual.add(path.relative_to(source).as_posix())
    if not blobs or actual != set(blobs):
        raise ValueError('Source YAML inventory differs from pinned commit')
    raw = git(source, 'cat-file', '--batch', data=b''.join(oid + b'\n' for oid in blobs.values()))
    offset, entries = 0, []
    for name, oid in blobs.items():
        end = raw.find(b'\n', offset)
        header = raw[offset:end].split()
        if len(header) != 3 or header[0] != oid or header[1] != b'blob':
            raise ValueError('Missing pinned source blob')
        start = end + 1
        size = int(header[2])
        pinned = raw[start:start + size]
        offset = start + size + 1
        current = regular_file(source / name)
        if current.replace(b'\r\n', b'\n') != pinned.replace(b'\r\n', b'\n'):
            raise ValueError('Source YAML bytes differ from pinned commit: ' + name)
        if Path(name).name.startswith('entries-'):
            entries.append((name, current))
    if not entries:
        raise ValueError('Missing entries-*.yaml source files')
    return entries


def collect_forms(files, released):
    source_bindings, seen_ids, forms = {}, set(), set()
    explicit_count = 0
    for name, body in files:
        data = yaml.load(body, Loader=UniqueLoader)
        if not isinstance(data, dict):
            raise ValueError('Expected entry mapping: ' + name)
        for lemma, groups in data.items():
            if not text(lemma) or lemma in source_bindings or not isinstance(groups, dict) or not groups:
                raise ValueError('Duplicate/invalid source lemma')
            bindings = set()
            for lexical_key, entry in groups.items():
                if (not text(lexical_key) or lexical_key[0] not in ('n', 'v', 'a', 's', 'r')
                        or not isinstance(entry, dict) or not isinstance(entry.get('sense'), list) or not entry['sense']):
                    raise ValueError('Invalid lexical group/senses: ' + lemma)
                pos = lexical_key[0]
                for sense in entry['sense']:
                    sid = sense.get('id')
                    if not text(sid) or sid in seen_ids:
                        raise ValueError('Duplicate/invalid source sense')
                    seen_ids.add(sid)
                    bindings.add((sid, pos))
                explicit = entry.get('form', [])
                if not isinstance(explicit, list) or any(not text(form) for form in explicit):
                    raise ValueError('Invalid explicit form array: ' + lemma)
                explicit_count += len(explicit)
                forms.update((form, lemma, pos) for form in explicit)
            source_bindings[lemma] = bindings
    if source_bindings != released:
        raise ValueError('Source/release lemma or sense/POS inventory mismatch')
    # Node is deliberately used instead of Python lower(): their Unicode versions
    # can differ. This is exactly the browser's NFC -> toLowerCase -> NFC contract.
    keys = sorted({form for form, _, _ in forms})
    result = subprocess.run(['node', '-e',
        "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);"
        "process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map("
        "x=>x.normalize('NFC').toLowerCase().normalize('NFC')))));"],
        input=encode(keys), stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=Path(__file__).resolve().parent)
    if result.returncode:
        raise ValueError('Cannot normalize form keys with Node: ' + result.stderr.decode('utf8', 'replace'))
    lowered = json.loads(result.stdout)
    if len(lowered) != len(keys) or any(not text(key) for key in lowered):
        raise ValueError('Invalid normalized form keys')
    lower = dict(zip(keys, lowered))
    grouped = {}
    for form, lemma, pos in forms:
        grouped.setdefault(lower[form], set()).add((lemma, pos))
    groups = [[key, [{'lemma': lemma, 'pos': pos} for lemma, pos in sorted(candidates)]]
              for key, candidates in sorted(grouped.items())]
    return groups, explicit_count


def shard_id(key):
    value = 0x811c9dc5
    for byte in key.encode('utf8'):
        value = ((value ^ byte) * 0x01000193) & 0xffffffff
    return f'{value:08x}'[:2]


def build(source, release_root, out):
    source, release_root, out = source.resolve(), release_root.resolve(), out.resolve()
    if out.exists() or not out.parent.is_dir() or any(out.is_relative_to(root) for root in (source, release_root)):
        raise ValueError('Output must be a new directory outside source and immutable release')
    manifest, released = read_release(release_root)
    commit = manifest['learningCommit']
    files = verify_source(source, commit)
    groups, explicit_count = collect_forms(files, released)
    release = manifest['release']
    version = 'forms-v1-' + sha256(encode({'release': release, 'sourceCommit': commit, 'entries': groups})).hexdigest()[:12]
    shards = {f'{n:02x}': {} for n in range(256)}
    for key, candidates in groups:
        shards[shard_id(key)][key] = candidates
    bodies = {shard + '.json': encode({'schema': 'oewn-form-index-v1', 'release': release,
              'indexVersion': version, 'shard': shard, 'entries': entries}) for shard, entries in shards.items()}
    summary = {'groupCount': len(groups), 'candidateCount': sum(len(c) for _, c in groups),
               'ambiguousCount': sum(len(c) > 1 for _, c in groups), 'explicitSourceFormCount': explicit_count,
               'sourceWordCount': len(released), 'sourceSenseCount': manifest['senseCount'],
               'bytes': sum(map(len, bodies.values())), 'maxShardBytes': max(map(len, bodies.values())),
               'maxShardGroups': max(map(len, shards.values())),
               'posCounts': dict(sorted(Counter(c['pos'] for _, candidates in groups for c in candidates).items()))}
    output_manifest = {'schema': 'oewn-form-index-manifest-v1', 'release': release, 'indexVersion': version,
                       'sourceCommit': commit, 'sourceInventorySha256': manifest['inventorySha256'],
                       'groupCount': len(groups), 'summary': summary,
                       'files': {name: {'sha256': sha256(body).hexdigest(), 'bytes': len(body)} for name, body in bodies.items()}}
    # Recheck the read-only source before the first write; no source helper code is executed.
    verify_source(source, commit)
    out.mkdir()
    destination = out / 'dictionary/form-indexes' / version
    destination.mkdir(parents=True)
    for name, body in {**bodies, 'manifest.json': encode(output_manifest)}.items():
        with (destination / name).open('xb') as stream:
            stream.write(body)
    return {**output_manifest, 'status': 'built-not-uploaded'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.release, args.out), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
