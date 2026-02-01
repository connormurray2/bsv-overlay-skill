import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

export default function register(api) {
  // Register the overlay agent tool
  api.registerTool({
    name: "overlay",
    description: "Access the BSV agent marketplace - discover agents and exchange BSV micropayments for services",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["request", "discover", "balance", "status", "pay"],
          description: "Action to perform"
        },
        service: {
          type: "string",
          description: "Service ID for request/discover"
        },
        input: {
          type: "object",
          description: "Service-specific input data"
        },
        maxPrice: {
          type: "number",
          description: "Max sats willing to pay"
        },
        identityKey: {
          type: "string",
          description: "Target agent key for direct pay"
        },
        sats: {
          type: "number",
          description: "Amount for direct pay"
        },
        description: {
          type: "string"
        },
        agent: {
          type: "string",
          description: "Agent name filter for discover"
        }
      },
      required: ["action"]
    },
    async execute(id, params) {
      const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
      
      try {
        const result = await executeOverlayAction(params, config, api);
        return { 
          content: [{ 
            type: "text", 
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }] 
        };
      } catch (error) {
        return { 
          content: [{ 
            type: "text", 
            text: `Error: ${error.message}` 
          }] 
        };
      }
    }
  });

  // Register background service for WebSocket relay
  api.registerService({
    id: "bsv-overlay-relay",
    start: async () => {
      api.logger.info("Starting BSV overlay WebSocket relay...");
      try {
        const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
        const env = buildEnvironment(config);
        const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');
        
        // Start the WebSocket connection
        const result = await execFileAsync('node', [cliPath, 'connect'], { env });
        api.logger.info("BSV overlay WebSocket relay started");
      } catch (error) {
        api.logger.error(`Failed to start BSV overlay relay: ${error.message}`);
      }
    },
    stop: async () => {
      api.logger.info("Stopping BSV overlay WebSocket relay...");
      // For Phase 1, we'll just log - proper process management would track the child process
      api.logger.info("BSV overlay WebSocket relay stopped");
    }
  });

  // Register CLI commands
  api.registerCli(({ program }) => {
    const overlay = program.command("overlay").description("BSV Overlay Network commands");
    
    overlay.command("status")
      .description("Show identity, balance, registration, and services")
      .action(async () => {
        try {
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
          const env = buildEnvironment(config);
          const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');
          
          // Get identity
          const identityResult = await execFileAsync('node', [cliPath, 'identity'], { env });
          const identity = parseCliOutput(identityResult.stdout);
          
          // Get balance
          const balanceResult = await execFileAsync('node', [cliPath, 'balance'], { env });
          const balance = parseCliOutput(balanceResult.stdout);
          
          // Get services
          const servicesResult = await execFileAsync('node', [cliPath, 'services'], { env });
          const services = parseCliOutput(servicesResult.stdout);
          
          console.log("BSV Overlay Status:");
          console.log("Identity:", identity.data);
          console.log("Balance:", balance.data);
          console.log("Services:", services.data);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
    
    overlay.command("setup")
      .description("Run initial wallet setup")
      .action(async () => {
        try {
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
          const env = buildEnvironment(config);
          const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');
          
          const result = await execFileAsync('node', [cliPath, 'setup'], { env });
          const output = parseCliOutput(result.stdout);
          console.log("Setup result:", output);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
    
    overlay.command("register")
      .description("Register with the overlay network")
      .action(async () => {
        try {
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
          const env = buildEnvironment(config);
          const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');
          
          const result = await execFileAsync('node', [cliPath, 'register'], { env });
          const output = parseCliOutput(result.stdout);
          console.log("Registration result:", output);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
  }, { commands: ["overlay"] });
}

async function executeOverlayAction(params, config, api) {
  const { action } = params;
  const env = buildEnvironment(config);
  const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');

  switch (action) {
    case "request":
      return await handleServiceRequest(params, env, cliPath, config, api);
    
    case "discover":
      return await handleDiscover(params, env, cliPath);
    
    case "balance":
      return await handleBalance(env, cliPath);
    
    case "status":
      return await handleStatus(env, cliPath);
    
    case "pay":
      return await handleDirectPay(params, env, cliPath);
    
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function handleServiceRequest(params, env, cliPath, config, api) {
  const { service, input, maxPrice } = params;
  
  if (!service) {
    throw new Error("Service is required for request action");
  }

  // 1. Discover providers for the service
  const discoverResult = await execFileAsync('node', [cliPath, 'discover', '--service', service], { env });
  const discoverOutput = parseCliOutput(discoverResult.stdout);
  
  if (!discoverOutput.success) {
    throw new Error(`Discovery failed: ${discoverOutput.error}`);
  }

  const providers = discoverOutput.data;
  if (!providers || providers.length === 0) {
    throw new Error(`No providers found for service: ${service}`);
  }

  // 2. Filter out our own identity key
  const identityResult = await execFileAsync('node', [cliPath, 'identity'], { env });
  const identityOutput = parseCliOutput(identityResult.stdout);
  const ourKey = identityOutput.data?.identityKey;
  
  const externalProviders = providers.filter(p => p.identityKey !== ourKey);
  if (externalProviders.length === 0) {
    throw new Error("No external providers available (only found our own services)");
  }

  // 3. Sort by price (pricingSats ascending)
  externalProviders.sort((a, b) => (a.pricingSats || 0) - (b.pricingSats || 0));
  
  const bestProvider = externalProviders[0];
  const price = bestProvider.pricingSats || 0;

  // 4. Check price limits
  const maxAutoPaySats = config.maxAutoPaySats || 200;
  const userMaxPrice = maxPrice || maxAutoPaySats;
  
  if (price > userMaxPrice) {
    throw new Error(`Service price (${price} sats) exceeds limit (${userMaxPrice} sats)`);
  }

  api.logger.info(`Requesting service ${service} from ${bestProvider.agentName} for ${price} sats`);

  // 5. Request the service
  const requestArgs = [cliPath, 'request-service', bestProvider.identityKey, service, price.toString()];
  if (input) {
    requestArgs.push(JSON.stringify(input));
  }
  
  const requestResult = await execFileAsync('node', requestArgs, { env });
  const requestOutput = parseCliOutput(requestResult.stdout);
  
  if (!requestOutput.success) {
    throw new Error(`Service request failed: ${requestOutput.error}`);
  }

  // 6. Poll for response
  const maxPollAttempts = 12; // ~60 seconds with 5 second intervals
  let attempts = 0;
  
  while (attempts < maxPollAttempts) {
    await sleep(5000); // Wait 5 seconds
    attempts++;
    
    try {
      const pollResult = await execFileAsync('node', [cliPath, 'poll'], { env });
      const pollOutput = parseCliOutput(pollResult.stdout);
      
      if (pollOutput.success && pollOutput.data) {
        // Check if we got a service response from our target provider
        const messages = Array.isArray(pollOutput.data) ? pollOutput.data : [pollOutput.data];
        for (const msg of messages) {
          if (msg.type === 'service-response' && msg.from === bestProvider.identityKey) {
            api.logger.info(`Received response from ${bestProvider.agentName}`);
            return {
              provider: bestProvider.agentName,
              cost: price,
              result: msg.payload
            };
          }
        }
      }
    } catch (pollError) {
      // Continue polling even if one poll fails
      api.logger.warn(`Poll attempt ${attempts} failed: ${pollError.message}`);
    }
  }
  
  throw new Error(`Service request timed out after ${maxPollAttempts * 5} seconds`);
}

async function handleDiscover(params, env, cliPath) {
  const { service, agent } = params;
  const args = [cliPath, 'discover'];
  
  if (service) {
    args.push('--service', service);
  }
  if (agent) {
    args.push('--agent', agent);
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Discovery failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleBalance(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'balance'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Balance check failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleStatus(env, cliPath) {
  try {
    // Get identity
    const identityResult = await execFileAsync('node', [cliPath, 'identity'], { env });
    const identity = parseCliOutput(identityResult.stdout);
    
    // Get balance
    const balanceResult = await execFileAsync('node', [cliPath, 'balance'], { env });
    const balance = parseCliOutput(balanceResult.stdout);
    
    // Get services
    const servicesResult = await execFileAsync('node', [cliPath, 'services'], { env });
    const services = parseCliOutput(servicesResult.stdout);
    
    return {
      identity: identity.data,
      balance: balance.data,
      services: services.data
    };
  } catch (error) {
    throw new Error(`Status check failed: ${error.message}`);
  }
}

async function handleDirectPay(params, env, cliPath) {
  const { identityKey, sats, description } = params;
  
  if (!identityKey || !sats) {
    throw new Error("identityKey and sats are required for pay action");
  }
  
  const args = [cliPath, 'pay', identityKey, sats.toString()];
  if (description) {
    args.push(description);
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Payment failed: ${output.error}`);
  }
  
  return output.data;
}

function buildEnvironment(config) {
  const env = { ...process.env };
  
  if (config.walletDir) {
    env.BSV_WALLET_DIR = config.walletDir;
  }
  if (config.overlayUrl) {
    env.OVERLAY_URL = config.overlayUrl;
  }
  
  // Set defaults
  env.BSV_NETWORK = env.BSV_NETWORK || 'mainnet';
  env.AGENT_NAME = env.AGENT_NAME || 'clawdbot-agent';
  
  return env;
}

function parseCliOutput(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Failed to parse CLI output: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}