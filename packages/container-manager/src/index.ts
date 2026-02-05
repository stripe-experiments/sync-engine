#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { ContainerManagerUI } from './ui/app.js';
import { DockerManager } from './docker/manager.js';
import { getDbStats } from './db/customerCount.js';
import { startServer } from './api/server.js';

const program = new Command();

program
  .name('stripe-sync-manager')
  .description('CLI GUI tool to manage Stripe Sync Docker containers')
  .version('1.0.0');

// Interactive TUI mode (default)
program
  .command('ui', { isDefault: true })
  .description('Launch the interactive terminal UI (htop-like)')
  .action(async () => {
    const ui = new ContainerManagerUI();
    await ui.start();
  });

// Add container command
program
  .command('add')
  .description('Add a new Stripe Sync container')
  .option('-k, --key <key>', 'Stripe API key')
  .option('-n, --name <name>', 'Container name')
  .option('-p, --port <port>', 'Base port number', parseInt)
  .action(async (options) => {
    const dockerManager = new DockerManager();
    await dockerManager.initialize();

    let stripeKey = options.key;

    if (!stripeKey) {
      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'stripeKey',
          message: 'Enter your Stripe API key:',
          mask: '*',
          validate: (input: string) =>
            input.startsWith('sk_') || input.startsWith('rk_') || 'Stripe API key must start with sk_ or rk_',
        },
      ]);
      stripeKey = answers.stripeKey;
    }

    // Check for duplicate Stripe key
    if (dockerManager.hasContainerForStripeKey(stripeKey)) {
      console.log(chalk.red('Error: A container with this Stripe API key already exists.'));
      console.log(chalk.gray('Each Stripe API key can only have one container.'));
      process.exit(1);
    }

    console.log(chalk.blue('Creating container...'));

    const container = await dockerManager.spawnContainer({
      stripeApiKey: stripeKey,
      name: options.name,
      port: options.port,
    });

    if (container.status === 'error') {
      console.log(chalk.red(`Error: ${container.error}`));
      process.exit(1);
    }

    console.log(chalk.green(`✓ Container "${container.name}" created successfully!`));
    console.log(chalk.gray(`  Port: ${container.port}`));
    console.log(chalk.gray(`  ID: ${container.id}`));
  });

// List containers command
program
  .command('list')
  .alias('ls')
  .description('List all Stripe Sync containers')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const dockerManager = new DockerManager();
    await dockerManager.initialize();

    const containers = await dockerManager.listContainers();

    if (options.json) {
      console.log(JSON.stringify(containers, null, 2));
      return;
    }

    if (containers.length === 0) {
      console.log(chalk.yellow('No containers found.'));
      console.log(chalk.gray('Use "stripe-sync-manager add" to create one.'));
      return;
    }

    console.log(chalk.bold('\nStripe Sync Containers:\n'));
    console.log(
      chalk.gray(
        '  NAME                 STATUS      PORT    CUSTOMERS  CREATED'
      )
    );
    console.log(chalk.gray('  ' + '-'.repeat(70)));

    for (const container of containers) {
      const statusColor =
        container.status === 'running'
          ? chalk.green
          : container.status === 'stopped'
            ? chalk.red
            : chalk.yellow;

      // Get customer count for running containers
      let customerCount = '-';
      if (container.status === 'running') {
        const stats = await getDbStats(container.name);
        if (stats?.customerCount !== null) {
          customerCount = stats?.customerCount?.toString() ?? '-';
        }
      }

      console.log(
        `  ${container.name.padEnd(20)} ${statusColor(container.status.padEnd(11))} ${container.port.toString().padEnd(7)} ${customerCount.padEnd(10)} ${container.createdAt.toLocaleDateString()}`
      );
    }

    console.log();
  });

// Stop container command
program
  .command('stop <name>')
  .description('Stop a container')
  .action(async (name) => {
    const dockerManager = new DockerManager();
    await dockerManager.initialize();

    const containers = await dockerManager.listContainers();
    const container = containers.find((c) => c.name === name || c.id === name);

    if (!container) {
      console.log(chalk.red(`Container "${name}" not found.`));
      process.exit(1);
    }

    console.log(chalk.blue(`Stopping container "${container.name}"...`));
    await dockerManager.stopContainer(container.id);
    console.log(chalk.green(`✓ Container "${container.name}" stopped.`));
  });

// Start/Resume container command
program
  .command('start <name>')
  .alias('resume')
  .description('Start/resume a stopped container')
  .action(async (name) => {
    const dockerManager = new DockerManager();
    await dockerManager.initialize();

    const containers = await dockerManager.listContainers();
    const container = containers.find((c) => c.name === name || c.id === name);

    if (!container) {
      console.log(chalk.red(`Container "${name}" not found.`));
      process.exit(1);
    }

    console.log(chalk.blue(`Starting container "${container.name}"...`));
    await dockerManager.startContainer(container.id);
    console.log(chalk.green(`✓ Container "${container.name}" started.`));
  });

// Delete container command
program
  .command('delete <name>')
  .alias('rm')
  .description('Delete a container')
  .option('-f, --force', 'Skip confirmation')
  .action(async (name, options) => {
    const dockerManager = new DockerManager();
    await dockerManager.initialize();

    const containers = await dockerManager.listContainers();
    const container = containers.find((c) => c.name === name || c.id === name);

    if (!container) {
      console.log(chalk.red(`Container "${name}" not found.`));
      process.exit(1);
    }

    if (!options.force) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Are you sure you want to delete "${container.name}"? This will remove all data.`,
          default: false,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray('Cancelled.'));
        return;
      }
    }

    console.log(chalk.blue(`Deleting container "${container.name}"...`));
    await dockerManager.deleteContainer(container.id);
    console.log(chalk.green(`✓ Container "${container.name}" deleted.`));
  });

// Stats command
program
  .command('stats <name>')
  .description('Show stats for a container')
  .action(async (name) => {
    const dockerManager = new DockerManager();
    await dockerManager.initialize();

    const containers = await dockerManager.listContainers();
    const container = containers.find((c) => c.name === name || c.id === name);

    if (!container) {
      console.log(chalk.red(`Container "${name}" not found.`));
      process.exit(1);
    }

    if (container.status !== 'running') {
      console.log(chalk.yellow(`Container "${container.name}" is not running.`));
      return;
    }

    console.log(chalk.bold(`\nStats for ${container.name}:\n`));

    const stats = await getDbStats(container.name);

    if (stats) {
      console.log(chalk.cyan('  Customers:    ') + (stats.customerCount ?? 'N/A'));
      console.log(chalk.cyan('  Subscriptions:') + (stats.subscriptionCount ?? 'N/A'));
      console.log(chalk.cyan('  Products:     ') + (stats.productCount ?? 'N/A'));
      console.log(chalk.cyan('  Invoices:     ') + (stats.invoiceCount ?? 'N/A'));
    } else {
      console.log(chalk.yellow('  Database not ready or no data synced yet.'));
    }

    console.log();
    console.log(chalk.gray(`  Port: ${container.port}`));
    console.log(chalk.gray(`  Stripe Key: ${container.stripeApiKey.slice(0, 12)}...`));
    console.log();
  });

// REST API server command
program
  .command('serve')
  .alias('api')
  .description('Start the REST API server')
  .option('-p, --port <port>', 'Port to listen on', '3456')
  .action((options) => {
    const port = parseInt(options.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.log(chalk.red('Invalid port number. Must be between 1 and 65535.'));
      process.exit(1);
    }
    startServer(port);
  });

// API endpoints help command
program
  .command('endpoints')
  .alias('curl')
  .description('Show all REST API endpoints with curl examples')
  .option('-p, --port <port>', 'API port for examples', '3456')
  .action((options) => {
    const port = options.port;
    const base = `http://localhost:${port}`;

    console.log(chalk.bold('\nREST API Endpoints:\n'));

    console.log(chalk.cyan('Health Check:'));
    console.log(chalk.gray(`  curl ${base}/health\n`));

    console.log(chalk.cyan('List all containers:'));
    console.log(chalk.gray(`  curl ${base}/api/containers`));
    console.log(chalk.gray(`  curl ${base}/api/containers?stats=true\n`));

    console.log(chalk.cyan('Get a container:'));
    console.log(chalk.gray(`  curl ${base}/api/containers/:id\n`));

    console.log(chalk.cyan('Get container stats:'));
    console.log(chalk.gray(`  curl ${base}/api/containers/:id/stats\n`));

    console.log(chalk.cyan('Create a container:'));
    console.log(chalk.gray(`  curl -X POST ${base}/api/containers \\`));
    console.log(chalk.gray(`    -H "Content-Type: application/json" \\`));
    console.log(chalk.gray(`    -d '{"stripeApiKey": "sk_test_..."}'\n`));

    console.log(chalk.cyan('Start a container:'));
    console.log(chalk.gray(`  curl -X POST ${base}/api/containers/:id/start\n`));

    console.log(chalk.cyan('Stop a container:'));
    console.log(chalk.gray(`  curl -X POST ${base}/api/containers/:id/stop\n`));

    console.log(chalk.cyan('Delete a container:'));
    console.log(chalk.gray(`  curl -X DELETE ${base}/api/containers/:id\n`));

    console.log(chalk.yellow('Note: Replace :id with the container ID or name.'));
    console.log(chalk.yellow(`Default API port is 3456. Use --port to change examples.\n`));
  });

program.parse();
