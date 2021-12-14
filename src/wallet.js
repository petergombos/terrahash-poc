const bip39 = require("bip39");
const BIP32Factory = require("bip32").default;
const bitcoin = require("bitcoinjs-lib");
const ecc = require("tiny-secp256k1");
const createHash = require("create-hash");

const { RegtestUtils } = require("regtest-client");
const regtestUtils = new RegtestUtils({
  bitcoin,
});

const bip32 = BIP32Factory(ecc);

async function fetch(endpoint) {
  const fetcher = (await import("node-fetch")).default;
  const response = await fetcher(endpoint);
  const json = await response.json();
  return json;
}

function api(endpoint) {
  return fetch(`http://localhost:3000${endpoint}`);
}

class Wallet {
  static generateMnemonic() {
    return bip39.generateMnemonic();
  }

  constructor({ mnemonic, path = "m/44'/0'/0'/0/0", network }) {
    this.mnemonic = mnemonic;
    this.network = network || bitcoin.networks.bitcoin;
    this.seed = bip39.mnemonicToSeedSync(this.mnemonic);
    this.root = bip32.fromSeed(this.seed);
    this.child = this.root.derivePath(path);
    this.address = this.getAddress();
    this.pubKeyHash = this.getPublicKeyHash();
    this.ECPair = this.getECPair();
  }

  getAddress() {
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: this.child.publicKey,
      network: this.network,
    });
    return address;
  }

  getPublicKeyHash() {
    const step1 = this.child.publicKey;
    const step2 = createHash("sha256").update(step1).digest();
    const pubKeyHash = createHash("rmd160").update(step2).digest();
    return pubKeyHash;
  }

  getECPair() {
    return bitcoin.ECPair.fromPrivateKey(this.child.privateKey);
  }

  async sync() {
    // Balance
    const { chain_stats } = await api(`/address/${this.address}`);
    this.balance = chain_stats.funded_txo_sum - chain_stats.spent_txo_sum;

    // UTXOs
    const utxos = await api(`/address/${this.address}/utxo`);
    this.utxos = utxos;
  }

  getFeesEstimate() {
    return fetch("https://blockstream.info/api/fee-estimates");
  }

  async send(to, amount) {
    await this.sync();
    const psbt = new bitcoin.Psbt({ network: this.network });

    let balance = 0;
    let inputCount = 0;

    // Add inputs
    const confirmedUTXOs = this.utxos.filter(
      (utxo) => utxo.status.confirmed === true
    );
    for (const utxo of confirmedUTXOs) {
      await psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from("0014" + this.pubKeyHash.toString("hex"), "hex"),
          value: utxo.value,
        },
      });

      balance += utxo.value;
      inputCount++;
    }

    const amountInSat = Math.round(amount * 100000000);

    if (balance < amountInSat) {
      throw new Error("Not enough funds");
    }
    // Estimates transaction size in weight units, needs to be divided by 4 to assess actual vBytes in most cases.
    // https://bitcoin.stackexchange.com/questions/95926/why-is-a-minrelaytxfee-of-1000-sat-kb-not-equivalent-to-250-sat-kw/95927#95927
    const txSize = inputCount * 180 + 2 * 34 + 10 + inputCount;
    const targetFees = await this.getFeesEstimate();
    const txfee = Math.round(txSize * (targetFees[1] / 4));

    const transferOutput = amountInSat - txfee;
    const changeOutput = balance - amountInSat;

    await psbt.addOutput({
      address: to,
      value: transferOutput,
    });

    if (changeOutput > 0) {
      await psbt.addOutput({
        address: this.address,
        value: changeOutput,
      });
    }

    for (let i = 0; i < inputCount; i++) {
      psbt.signInput(i, this.ECPair);
      psbt.validateSignaturesOfInput(i);
    }

    psbt.finalizeAllInputs();

    const tx = psbt.extractTransaction().toHex();

    await regtestUtils.broadcast(tx); // TODO: add support for testnet and mainnet

    return tx;
  }
}

module.exports = Wallet;

async function main() {
  const wallet = new Wallet({
    mnemonic:
      "blouse blossom fade disagree matrix deer clog pulp rich survey atom tackle",
    path: "m/0'/0'/0'",
    network: bitcoin.networks.regtest,
  });

  await wallet.sync();
  console.log(wallet.balance);
}

// main();
