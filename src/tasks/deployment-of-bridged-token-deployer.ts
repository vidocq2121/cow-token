import { promises as fs } from "fs";

import { constants, utils } from "ethers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  computeProofs,
  parseCsvFile,
  DeploymentHelperDeployParams,
  generateProposal,
  constructorInput,
  ContractName,
} from "../ts";
import { Args, Settings } from "../ts/lib/common-interfaces";
import { defaultTokens } from "../ts/lib/constants";
import { dummyVirtualTokenCreationSettings } from "../ts/lib/dummy-instantiation";
import { removeSplitClaimFiles, splitClaimsAndSaveToFolder } from "../ts/split";

import { defaultSafeDeploymentAddresses } from "./ts/safe";

export const OUTPUT_FOLDER_GC = "./output/deployment-gc";

const setupBridgedTokenDeployerTask: () => void = () => {
  task(
    "deployment-bridged-token-deployer",
    "Generate the list of claims from a csv and reads settings from json and deploys the bridged token deployer on gnosis chain",
  )
    .addParam(
      "claims",
      "Path to the CSV file that contains the list of claims to generate.",
    )
    .addParam(
      "settings",
      "Path to the JSON file that contains the deployment settings.",
    )
    .setAction(generateDeployment);
};

async function generateDeployment(
  { claims: claimCsv, settings: settingsJson }: Args,
  hre: HardhatRuntimeEnvironment,
): Promise<void> {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();

  const chainId = (await hre.ethers.provider.getNetwork()).chainId.toString();
  if (chainId !== "100") {
    throw new Error(
      `This script must be run on gnosis chain. Found chainId ${chainId}`,
    );
  }

  const settings: Settings = JSON.parse(
    await fs.readFile(settingsJson, "utf8"),
  );
  console.log(`Using deployer ${deployer.address}`);

  console.log("Reading user claims for gnosis chain from file...");
  const claims = await parseCsvFile(claimCsv);

  console.log("Generating Merkle proofs...");
  const { merkleRoot, claims: claimsWithProof } = computeProofs(claims);

  const dummySettings = {
    ...settings,
    virtualCowToken: dummyVirtualTokenCreationSettings,
    multiTokenMediatorGnosisChain: constants.AddressZero,
  };

  // In the following function, we are generating the addresses, as they would
  // be generated within the mainnet deployment script - but with many zero
  // addresses and hashes, as displayed in the settings definition
  // Hence, we rely on the fact that the addresses computed by generateProposal
  // for the cowDao and cowToken do not depend on the virtual token deployment
  // parameters.
  // For double security, one can also provide the expected values in as expected
  // setting variables
  const {
    addresses: { cowToken, cowDao },
  } = await generateProposal(
    dummySettings,
    {
      ...defaultSafeDeploymentAddresses(chainId),
      forwarder: constants.AddressZero,
    },
    {
      ...defaultSafeDeploymentAddresses("100"),
      forwarder: constants.AddressZero,
    },
    hre.ethers,
  );

  if (settings.cowToken.expectedAddress !== undefined) {
    if (
      settings.cowToken.expectedAddress.toLowerCase() !== cowToken.toLowerCase()
    ) {
      throw new Error(
        `Expected cowToken address ${settings.cowToken.expectedAddress} does not coincide with calculated address ${cowToken}`,
      );
    }
  } else {
    console.warn("settings.cowToken.expectedAddress was not defined");
  }

  if (settings.cowDao.expectedAddress !== undefined) {
    if (
      settings.cowDao.expectedAddress.toLowerCase() !== cowDao.toLowerCase()
    ) {
      throw new Error(
        "Expected cowDao address does not coincide with calculated address",
      );
    }
  } else {
    console.warn("settings.cowDao.expectedAddress was not defined");
  }

  const deploymentHelperParameters: DeploymentHelperDeployParams = {
    foreignToken: cowToken,
    multiTokenMediatorGnosisChain:
      settings.bridge.multiTokenMediatorGnosisChain,
    merkleRoot,
    communityFundsTarget: cowDao,
    gnoToken: defaultTokens.gno[chainId],
    gnoPrice: settings.virtualCowToken.gnoPrice,
    nativeTokenPrice: utils.parseUnits("0.15", 18), // the price of one unit of COW in xDAI
    wrappedNativeToken: defaultTokens.weth[chainId],
  };

  console.log(
    "The following deployment parameters will be used",
    deploymentHelperParameters,
  );

  const BridgedTokenDeployer = await hre.ethers.getContractFactory(
    "BridgedTokenDeployer",
  );
  const bridgedTokenDeployer = await BridgedTokenDeployer.deploy(
    ...constructorInput(
      ContractName.BridgedTokenDeployer,
      deploymentHelperParameters,
    ),
  );

  console.log("Clearing old files...");
  await fs.rm(`${OUTPUT_FOLDER_GC}/claims.json`, {
    recursive: true,
    force: true,
  });
  await fs.rm(`${OUTPUT_FOLDER_GC}/params.json`, {
    recursive: true,
    force: true,
  });
  await removeSplitClaimFiles(OUTPUT_FOLDER_GC);

  console.log("Saving generated data to file...");
  await fs.mkdir(OUTPUT_FOLDER_GC, { recursive: true });
  await fs.writeFile(
    `${OUTPUT_FOLDER_GC}/addresses.json`,
    JSON.stringify(bridgedTokenDeployer.address, undefined, 2),
  );
  await fs.writeFile(
    `${OUTPUT_FOLDER_GC}/claims.json`,
    JSON.stringify(claimsWithProof),
  );
  await splitClaimsAndSaveToFolder(claimsWithProof, OUTPUT_FOLDER_GC);
}

export { setupBridgedTokenDeployerTask };
