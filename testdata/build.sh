#!/usr/bin/env bash

# bash testdata/build.sh

set -euo pipefail

ROOT_DIR=$(dirname "${BASH_SOURCE[0]}")

tlb2txt() {
  name="$1"
  # tlbc build form https://github.com/dungeon-master-666/ton/tree/ton-indexer rev: bbef0721db26af32b758d5f973639dc0045d2e3a
  tlbc -qv "$ROOT_DIR/$name.tlb" 2>&1 | tee "$ROOT_DIR/$name.txt"
}

fetch() {
  name="$1"
  url="$2"
  wget -q -O "$ROOT_DIR/$name.tlb" "$url"  
}

fetch schemes https://github.com/toncenter/ton-indexer/raw/7829755ab6427e18ed94a6a7b076751115ea03a2/ton-index-worker/ton-marker/src/schemes/schemes.tlb
tlb2txt schemes
fetch block https://github.com/ton-blockchain/ton/raw/37f10de155f9fb51037c048a8e3d3d94ef91b6cc/crypto/block/block.tlb
tlb2txt block
