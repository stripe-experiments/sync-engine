import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { DockerManager } from '../docker/manager.js';
import { getCustomerCount, getDbStats } from '../db/customerCount.js';
import { startServer } from '../api/server.js';
import type { ContainerInfo } from '../types.js';

export class ContainerManagerUI {
  private screen: blessed.Widgets.Screen;
  private grid: contrib.grid;
  private table: contrib.Widgets.TableElement;
  private log: contrib.Widgets.LogElement;
  private statsBox: blessed.Widgets.BoxElement;
  private helpBar: blessed.Widgets.BoxElement;
  private dockerManager: DockerManager;
  private containers: ContainerInfo[] = [];
  private selectedIndex: number = 0;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.dockerManager = new DockerManager();

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      mouse: true,
      title: 'Stripe Sync Container Manager',
      cursor: {
        artificial: true,
        shape: 'line',
        blink: true,
        color: null,
      },
    });

    // Create grid layout (12x12)
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    // Title bar
    this.grid.set(0, 0, 1, 12, blessed.box, {
      content: 'Stripe Sync Container Manager',
      align: 'center',
      bold: true,
      style: {
        fg: 'white',
        bg: 'blue',
        bold: true,
      },
    });

    // Container table (main area)
    this.table = this.grid.set(1, 0, 8, 9, contrib.table, {
      keys: true,
      mouse: true,
      fg: 'white',
      selectedFg: 'black',
      selectedBg: 'green',
      interactive: true,
      label: ' Containers ',
      border: { type: 'line', fg: 'cyan' },
      columnSpacing: 2,
      columnWidth: [20, 12, 10, 12, 12, 15],
    }) as contrib.Widgets.TableElement;

    // Handle table row selection via mouse click
    this.table.rows.on('select', (_item: any, index: number) => {
      if (index >= 0 && index < this.containers.length) {
        this.selectedIndex = index;
        this.updateTable();
        this.updateStats();
      }
    });

    // Stats box (right side)
    this.statsBox = this.grid.set(1, 9, 4, 3, blessed.box, {
      label: ' Stats ',
      border: { type: 'line', fg: 'cyan' },
      tags: true,
      content: 'Select a container\nto view stats',
      style: {
        fg: 'white',
      },
    }) as blessed.Widgets.BoxElement;

    // Info box for additional stats
    this.grid.set(5, 9, 4, 3, blessed.box, {
      label: ' Info ',
      border: { type: 'line', fg: 'cyan' },
      tags: true,
      content: '{cyan-fg}Stripe Sync{/cyan-fg}\n\nManage your\nDocker containers\nfor syncing\nStripe data.',
      style: {
        fg: 'white',
      },
    });

    // Log area
    this.log = this.grid.set(9, 0, 2, 12, contrib.log, {
      fg: 'green',
      selectedFg: 'green',
      label: ' Logs ',
      border: { type: 'line', fg: 'cyan' },
    }) as contrib.Widgets.LogElement;

    // Help bar at bottom
    this.helpBar = this.grid.set(11, 0, 1, 12, blessed.box, {
      content:
        ' {bold}a{/bold}:Add | {bold}d{/bold}:Delete | {bold}s{/bold}:Stop | {bold}r{/bold}:Resume | {bold}↑↓{/bold}:Navigate | {bold}q{/bold}:Quit | {bold}F5{/bold}:Refresh ',
      tags: true,
      style: {
        fg: 'white',
        bg: 'blue',
      },
    }) as blessed.Widgets.BoxElement;

    this.setupKeyBindings();
  }

  private setupKeyBindings(): void {
    // Quit
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.cleanup();
      process.exit(0);
    });

    // Add container
    this.screen.key(['a'], () => {
      this.showAddContainerDialog();
    });

    // Delete container
    this.screen.key(['d'], () => {
      this.deleteSelectedContainer();
    });

    // Stop container
    this.screen.key(['s'], () => {
      this.stopSelectedContainer();
    });

    // Resume/Start container
    this.screen.key(['r'], () => {
      this.resumeSelectedContainer();
    });

    // Refresh
    this.screen.key(['f5', 'C-r'], () => {
      this.refresh();
    });

    // Navigation
    this.screen.key(['up', 'k'], () => {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.updateTable();
        this.updateStats();
      }
    });

    this.screen.key(['down', 'j'], () => {
      if (this.selectedIndex < this.containers.length - 1) {
        this.selectedIndex++;
        this.updateTable();
        this.updateStats();
      }
    });
  }

  private async showAddContainerDialog(): Promise<void> {
    // Create a form dialog
    const form = blessed.form({
      parent: this.screen,
      keys: true,
      vi: true,
      left: 'center',
      top: 'center',
      width: 60,
      height: 10,
      border: 'line',
      label: ' Add Container ',
      style: {
        border: { fg: 'cyan' },
      },
    });

    // Label
    blessed.text({
      parent: form,
      top: 1,
      left: 2,
      content: 'Enter Stripe API Key (sk_...):',
      style: { fg: 'white' },
    });

    // Text input
    const input = blessed.textbox({
      parent: form,
      name: 'stripeKey',
      top: 3,
      left: 2,
      right: 2,
      height: 3,
      inputOnFocus: true,
      border: 'line',
      style: {
        fg: 'white',
        border: { fg: 'blue' },
        focus: { border: { fg: 'green' } },
      },
    });

    // Instructions
    blessed.text({
      parent: form,
      top: 7,
      left: 2,
      content: 'Enter: Submit | Escape: Cancel',
      style: { fg: 'gray' },
    });

    // Focus the input
    input.focus();

    // Handle submit
    input.on('submit', async (value: string) => {
      form.destroy();
      this.screen.render();

      const stripeKey = value?.trim();

      if (!stripeKey) {
        this.log.log('Add container cancelled - no key entered');
        this.screen.render();
        return;
      }

      if (!stripeKey.startsWith('sk_') && !stripeKey.startsWith('rk_')) {
        this.log.log('ERROR: Invalid Stripe API key. Must start with sk_ or rk_');
        this.screen.render();
        return;
      }

      // Check for duplicate
      if (this.dockerManager.hasContainerForStripeKey(stripeKey)) {
        this.log.log('ERROR: A container with this Stripe API key already exists');
        this.screen.render();
        return;
      }

      this.log.log(`Creating container with Stripe key: ${stripeKey.slice(0, 10)}...`);
      this.screen.render();

      try {
        const container = await this.dockerManager.spawnContainer({
          stripeApiKey: stripeKey,
        });

        if (container.status === 'error') {
          this.log.log(`ERROR: Error creating container: ${container.error}`);
        } else {
          this.log.log(`OK: Container ${container.name} created on port ${container.port}`);
        }

        await this.refresh();
      } catch (error) {
        this.log.log(`ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      this.screen.render();
    });

    // Handle cancel
    input.on('cancel', () => {
      form.destroy();
      this.log.log('Add container cancelled');
      this.screen.render();
    });

    // Also handle escape on the form
    form.key(['escape'], () => {
      form.destroy();
      this.log.log('Add container cancelled');
      this.screen.render();
    });

    this.screen.render();
  }

  private async deleteSelectedContainer(): Promise<void> {
    const container = this.containers[this.selectedIndex];
    if (!container) {
      this.log.log('No container selected');
      return;
    }

    const question = blessed.question({
      parent: this.screen,
      border: 'line',
      height: 'shrink',
      width: 'half',
      top: 'center',
      left: 'center',
      label: ' Confirm Delete ',
      tags: true,
      keys: true,
      vi: true,
    });

    question.ask(`Delete container "${container.name}"? (y/n)`, async (err, value) => {
      if (value) {
        this.log.log(`Deleting container ${container.name}...`);
        this.screen.render();

        try {
          await this.dockerManager.deleteContainer(container.id);
          this.log.log(`OK: Container ${container.name} deleted`);
          this.selectedIndex = Math.max(0, this.selectedIndex - 1);
          await this.refresh();
        } catch (error) {
          this.log.log(`ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      this.screen.render();
    });
  }

  private async stopSelectedContainer(): Promise<void> {
    const container = this.containers[this.selectedIndex];
    if (!container) {
      this.log.log('No container selected');
      return;
    }

    if (container.status !== 'running') {
      this.log.log(`Container ${container.name} is not running`);
      return;
    }

    this.log.log(`Stopping container ${container.name}...`);
    this.screen.render();

    try {
      await this.dockerManager.stopContainer(container.id);
      this.log.log(`OK: Container ${container.name} stopped`);
      await this.refresh();
    } catch (error) {
      this.log.log(`ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    this.screen.render();
  }

  private async resumeSelectedContainer(): Promise<void> {
    const container = this.containers[this.selectedIndex];
    if (!container) {
      this.log.log('No container selected');
      return;
    }

    if (container.status === 'running') {
      this.log.log(`Container ${container.name} is already running`);
      return;
    }

    this.log.log(`Starting container ${container.name}...`);
    this.screen.render();

    try {
      await this.dockerManager.startContainer(container.id);
      this.log.log(`OK: Container ${container.name} started`);
      await this.refresh();
    } catch (error) {
      this.log.log(`ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    this.screen.render();
  }

  private updateTable(): void {
    const headers = ['Name', 'Status', 'Port', 'Customers', 'Created', 'Stripe Key'];

    const data = this.containers.map((container, index) => {
      const statusIndicator =
        container.status === 'running'
          ? '[OK]'
          : container.status === 'stopped'
            ? '[--]'
            : '[..]';

      const selected = index === this.selectedIndex ? '> ' : '  ';

      return [
        `${selected}${container.name}`,
        `${statusIndicator} ${container.status}`,
        container.port.toString(),
        container.customerCount !== null ? container.customerCount.toString() : '-',
        container.createdAt.toLocaleDateString(),
        `${container.stripeApiKey.slice(0, 12)}...`,
      ];
    });

    this.table.setData({
      headers,
      data: data.length > 0 ? data : [['No containers', '', '', '', '', '']],
    });

    this.screen.render();
  }

  private async updateStats(): Promise<void> {
    const container = this.containers[this.selectedIndex];
    if (!container) {
      this.statsBox.setContent('No container selected');
      this.screen.render();
      return;
    }

    this.statsBox.setContent(`{bold}${container.name}{/bold}\n\nLoading stats...`);
    this.screen.render();

    const stats = await getDbStats(container.name);

    if (stats) {
      this.statsBox.setContent(
        `{bold}${container.name}{/bold}\n\n` +
          `{cyan-fg}Customers:{/cyan-fg} ${stats.customerCount ?? 'N/A'}\n` +
          `{cyan-fg}Subscriptions:{/cyan-fg} ${stats.subscriptionCount ?? 'N/A'}\n` +
          `{cyan-fg}Products:{/cyan-fg} ${stats.productCount ?? 'N/A'}\n` +
          `{cyan-fg}Invoices:{/cyan-fg} ${stats.invoiceCount ?? 'N/A'}\n\n` +
          `{green-fg}Port:{/green-fg} ${container.port}\n` +
          `{green-fg}Status:{/green-fg} ${container.status}`
      );

      // Update the container's customer count
      container.customerCount = stats.customerCount;
      this.updateTable();
    } else {
      this.statsBox.setContent(
        `{bold}${container.name}{/bold}\n\n` +
          `{yellow-fg}Database not ready{/yellow-fg}\n\n` +
          `{green-fg}Port:{/green-fg} ${container.port}\n` +
          `{green-fg}Status:{/green-fg} ${container.status}`
      );
    }

    this.screen.render();
  }

  private async refresh(): Promise<void> {
    this.log.log('Refreshing containers...');
    this.screen.render();

    try {
      this.containers = await this.dockerManager.listContainers();

      // Update customer counts for all containers
      for (const container of this.containers) {
        if (container.status === 'running') {
          const count = await getCustomerCount(container.name);
          container.customerCount = count;
        }
      }

      this.updateTable();
      await this.updateStats();
      this.log.log(`Found ${this.containers.length} container(s)`);
    } catch (error) {
      this.log.log(`ERROR: Refreshing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    this.screen.render();
  }

  private cleanup(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  async start(): Promise<void> {
    this.log.log('Initializing Stripe Sync Container Manager...');
    this.screen.render();

    // Start REST API server in background
    startServer(3456);

    await this.dockerManager.initialize();
    await this.refresh();

    // Auto-refresh every 30 seconds
    this.refreshInterval = setInterval(() => {
      this.refresh();
    }, 30000);

    this.screen.render();
  }
}
