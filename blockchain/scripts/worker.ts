import hre from "hardhat";
const { ethers } = hre;
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

dotenv.config();

const CONTRACT_ABI = [
  "function registerEvidence(bytes32 evidenceKey, bytes32 evidenceHash) external",
  "function anchorCustodyEvent(bytes32 evidenceKey, bytes32 eventKey, bytes32 eventHash, uint8 action) external",
  "function verifyEvidenceHash(bytes32 evidenceKey, bytes32 evidenceHash) external view returns (bool)",
  "function getEvidenceRecord(bytes32 evidenceKey) external view returns (bytes32, bytes32, uint256, bool)",
];

export async function processPendingAnchors() {
  console.log("[WORKER] Starting Blockchain Anchor Processing Worker...");

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error("[WORKER ERROR] Missing Supabase URL or Key.");
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const [signer] = await ethers.getSigners();
  const contractAddress = process.env.BLOCKCHAIN_CONTRACT_ADDRESS || "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  
  console.log(`[WORKER] Connected Signer: ${signer.address}`);
  console.log(`[WORKER] Target Contract: ${contractAddress}`);

  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, signer);

  const { data: pendingAnchors, error } = await supabase
    .from("blockchain_anchors")
    .select("*")
    .in("status", ["PENDING", "FAILED"])
    .limit(10);

  if (error) {
    console.error("[WORKER ERROR] Failed to fetch pending anchors:", error.message);
    return;
  }

  if (!pendingAnchors || pendingAnchors.length === 0) {
    console.log("[WORKER] No pending blockchain anchors to process.");
    return;
  }

  console.log(`[WORKER] Found ${pendingAnchors.length} pending anchor(s) to process.`);

  for (const anchor of pendingAnchors) {
    try {
      await supabase
        .from("blockchain_anchors")
        .update({ status: "PROCESSING" })
        .eq("id", anchor.id);

      const evidenceKey = ethers.id(anchor.evidence_id);
      const dataHash = anchor.data_hash.startsWith("0x") ? anchor.data_hash : ethers.id(anchor.data_hash);

      let tx: any;

      if (anchor.anchor_type === "EVIDENCE") {
        const isAlreadyVerified = await contract.verifyEvidenceHash(evidenceKey, dataHash).catch(() => false);
        if (isAlreadyVerified) {
          console.log(`[WORKER] Evidence ${anchor.evidence_id} is already anchored on-chain.`);
          await supabase
            .from("blockchain_anchors")
            .update({
              status: "CONFIRMED",
              confirmed_at: new Date().toISOString(),
              error_message: null
            })
            .eq("id", anchor.id);
          continue;
        }

        console.log(`[WORKER] Submitting registerEvidence for ${anchor.evidence_id}...`);
        tx = await contract.registerEvidence(evidenceKey, dataHash);
      } else if (anchor.anchor_type === "CUSTODY") {
        const eventKey = ethers.id(anchor.reference_id || anchor.id);
        console.log(`[WORKER] Submitting anchorCustodyEvent for event ${anchor.reference_id}...`);
        tx = await contract.anchorCustodyEvent(evidenceKey, eventKey, dataHash, 1);
      }

      console.log(`[WORKER] Transaction submitted: ${tx.hash}. Waiting for confirmation...`);
      const receipt = await tx.wait(1);

      await supabase
        .from("blockchain_anchors")
        .update({
          status: "CONFIRMED",
          transaction_hash: receipt.hash,
          block_number: receipt.blockNumber,
          chain_id: "31337",
          contract_address: contractAddress,
          confirmed_at: new Date().toISOString(),
          error_message: null
        })
        .eq("id", anchor.id);

      console.log(`[WORKER SUCCESS] Anchor ${anchor.id} confirmed in block ${receipt.blockNumber}.`);
    } catch (anchorErr: any) {
      console.error(`[WORKER ERROR] Anchor ${anchor.id} failed:`, anchorErr?.message || anchorErr);
      await supabase
        .from("blockchain_anchors")
        .update({
          status: "FAILED",
          error_message: anchorErr?.message || "Transaction execution failed."
        })
        .eq("id", anchor.id);
    }
  }
}

if (require.main === module) {
  processPendingAnchors()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
