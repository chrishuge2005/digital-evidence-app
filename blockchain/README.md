# Blockchain Trust Layer & Anchoring Architecture

This directory contains the EVM-compatible smart contract, deployment scripts, unit tests, and backend processing workers for the Digital Evidence Management System.

---

## 1. Architecture Overview

```text
React Native Client
        │
        ▼ (queues PENDING anchor)
Supabase DB (blockchain_anchors)
        │
        ▼ (reads PENDING anchors)
Secure Backend Worker / Supabase Edge Function
        │
        ▼ (signs EVM transaction with private key)
EVM Network (Polygon / Ethereum / Local Hardhat)
        │
        ▼ (emits EvidenceAnchored / CustodyEventAnchored)
EvidenceAnchor Smart Contract
        │
        ▼ (updates transaction_hash & CONFIRMED status)
Supabase DB & Mobile App Verification Status
```

* **Client Security:** The React Native mobile client **never** holds private signing keys or signs transactions directly.
* **Privacy:** Only cryptographic hashes (`evidenceHash`, `eventHash`) are registered on-chain. No PII, filenames, or user metadata are ever sent to the blockchain.

---

## 2. Smart Contract Specs (`EvidenceAnchor.sol`)

* **Solidity Version:** `0.8.20`
* **Access Control:** OpenZeppelin `AccessControl`
  * `DEFAULT_ADMIN_ROLE`: Admin authority to manage roles.
  * `ANCHOR_WRITER_ROLE`: Granted exclusively to the backend signing wallet.
* **Key Methods:**
  * `registerEvidence(bytes32 evidenceKey, bytes32 evidenceHash)`
  * `anchorCustodyEvent(bytes32 evidenceKey, bytes32 eventKey, bytes32 eventHash, uint8 action)`
  * `verifyEvidenceHash(bytes32 evidenceKey, bytes32 evidenceHash)`
  * `getEvidenceRecord(bytes32 evidenceKey)`
  * `getCustodyRecord(bytes32 eventKey)`

---

## 3. Environment Variables

Create `.env` in the root directory (never commit to Git):

```env
# Public Supabase Client Config
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Backend Worker Config (Server-side ONLY)
BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545
BLOCKCHAIN_PRIVATE_KEY=your-private-key-without-0x
BLOCKCHAIN_CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
BLOCKCHAIN_CHAIN_ID=31337
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

---

## 4. Local Hardhat Testing & Deployment

### Run Unit Tests
```bash
cd blockchain
npx hardhat test
```

### Start Local Hardhat EVM Node
```bash
cd blockchain
npx hardhat node
```

### Deploy Contract to Local Node
```bash
cd blockchain
npx hardhat run scripts/deploy.ts --network localhost
```

---

## 5. Supabase Edge Function Deployment

Deploy the Edge Function to process `blockchain_anchors` asynchronously:

```bash
supabase functions deploy process-blockchain-anchor --no-verify-jwt
supabase secrets set BLOCKCHAIN_RPC_URL=https://polygon-amoy.infura.io/v3/... BLOCKCHAIN_PRIVATE_KEY=... BLOCKCHAIN_CONTRACT_ADDRESS=0x...
```

---

## 6. Three-Layer Verification System

1. **Layer 1 (Local File):** Generates byte-for-byte SHA-256 hash from local device file.
2. **Layer 2 (Supabase Cloud):** Compares hash against stored immutable metadata record.
3. **Layer 3 (Blockchain Trust Layer):** Queries smart contract on EVM network to verify cryptographic proof anchor match.
