import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.11.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// EvidenceAnchor Minimal ABI
const CONTRACT_ABI = [
  "function registerEvidence(bytes32 evidenceKey, bytes32 evidenceHash) external",
  "function anchorCustodyEvent(bytes32 evidenceKey, bytes32 eventKey, bytes32 eventHash, uint8 action) external",
  "function verifyEvidenceHash(bytes32 evidenceKey, bytes32 evidenceHash) external view returns (bool)",
  "function getEvidenceRecord(bytes32 evidenceKey) external view returns (bytes32, bytes32, uint256, bool)",
  "event EvidenceAnchored(bytes32 indexed evidenceKey, bytes32 evidenceHash, uint256 timestamp)",
  "event CustodyEventAnchored(bytes32 indexed evidenceKey, bytes32 indexed eventKey, bytes32 eventHash, uint8 action, uint256 timestamp)"
];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const rpcUrl = Deno.env.get("BLOCKCHAIN_RPC_URL");
    const privateKey = Deno.env.get("BLOCKCHAIN_PRIVATE_KEY");
    const contractAddress = Deno.env.get("BLOCKCHAIN_CONTRACT_ADDRESS");
    const chainId = Deno.env.get("BLOCKCHAIN_CHAIN_ID") || "31337";

    if (!rpcUrl || !privateKey || !contractAddress) {
      return new Response(
        JSON.stringify({ error: "Missing backend blockchain configuration environment variables." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const anchorId = body?.anchorId;

    let query = supabase
      .from("blockchain_anchors")
      .select("*")
      .in("status", ["PENDING", "FAILED"]);

    if (anchorId) {
      query = query.eq("id", anchorId);
    } else {
      query = query.limit(10);
    }

    const { data: pendingAnchors, error: fetchError } = await query;

    if (fetchError) {
      throw fetchError;
    }

    if (!pendingAnchors || pendingAnchors.length === 0) {
      return new Response(
        JSON.stringify({ message: "No pending blockchain anchors to process.", processed: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results = [];

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
            await supabase
              .from("blockchain_anchors")
              .update({
                status: "CONFIRMED",
                blockchain_network: anchor.blockchain_network || "evm_network",
                chain_id: chainId,
                contract_address: contractAddress,
                confirmed_at: new Date().toISOString(),
                error_message: null
              })
              .eq("id", anchor.id);

            results.push({ id: anchor.id, status: "CONFIRMED", reason: "Already anchored on contract" });
            continue;
          }

          tx = await contract.registerEvidence(evidenceKey, dataHash);
        } else if (anchor.anchor_type === "CUSTODY") {
          const eventKey = ethers.id(anchor.reference_id || anchor.id);
          const actionType = 1;
          tx = await contract.anchorCustodyEvent(evidenceKey, eventKey, dataHash, actionType);
        } else {
          throw new Error(`Unsupported anchor_type: ${anchor.anchor_type}`);
        }

        const receipt = await tx.wait(1);

        await supabase
          .from("blockchain_anchors")
          .update({
            status: "CONFIRMED",
            transaction_hash: receipt.hash,
            block_number: receipt.blockNumber,
            chain_id: chainId,
            contract_address: contractAddress,
            confirmed_at: new Date().toISOString(),
            error_message: null
          })
          .eq("id", anchor.id);

        results.push({ id: anchor.id, status: "CONFIRMED", txHash: receipt.hash, blockNumber: receipt.blockNumber });
      } catch (anchorErr: any) {
        console.error(`Error anchoring ID ${anchor.id}:`, anchorErr?.message || anchorErr);

        await supabase
          .from("blockchain_anchors")
          .update({
            status: "FAILED",
            error_message: anchorErr?.message || "Blockchain transaction execution failed."
          })
          .eq("id", anchor.id);

        results.push({ id: anchor.id, status: "FAILED", error: anchorErr?.message });
      }
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
