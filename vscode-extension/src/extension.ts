import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const didChangeEmitter = new vscode.EventEmitter<void>();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('homeAssistantMcp')) {
        didChangeEmitter.fire();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hass-mcp-server.setToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your Home Assistant Long-Lived Access Token',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await context.secrets.store('haToken', token);
        vscode.window.showInformationMessage(
          'Home Assistant access token saved.',
        );
        didChangeEmitter.fire();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'hass-mcp-server.deleteToken',
      async () => {
        await context.secrets.delete('haToken');
        vscode.window.showInformationMessage(
          'Home Assistant access token deleted.',
        );
        didChangeEmitter.fire();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'hass-mcp-server.setSshPassword',
      async () => {
        const password = await vscode.window.showInputBox({
          prompt: 'Enter your SSH password for Home Assistant',
          password: true,
          ignoreFocusOut: true,
        });
        if (password) {
          await context.secrets.store('haSshPassword', password);
          vscode.window.showInformationMessage(
            'Home Assistant SSH password saved.',
          );
          didChangeEmitter.fire();
        }
      },
    ),
  );

  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === 'haToken' || e.key === 'haSshPassword') {
        didChangeEmitter.fire();
      }
    }),
  );

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('homeAssistantMcp', {
      onDidChangeMcpServerDefinitions: didChangeEmitter.event,
      provideMcpServerDefinitions: async () => {
        const config = vscode.workspace.getConfiguration('homeAssistantMcp');
        const url = config.get<string>('url', '');
        const token = await context.secrets.get('haToken');

        if (!url || !token) {
          return [];
        }

        const env: Record<string, string> = {
          HA_URL: url,
          HA_TOKEN: token,
        };

        const sshHost = config.get<string>('ssh.host', '');
        if (sshHost) {
          env.HA_SSH_HOST = sshHost;

          const sshPort = config.get<number>('ssh.port', 22);
          if (sshPort !== 22) {
            env.HA_SSH_PORT = String(sshPort);
          }

          const sshUser = config.get<string>('ssh.user', '');
          if (sshUser) {
            env.HA_SSH_USER = sshUser;
          }

          const sshKeyPath = config.get<string>('ssh.keyPath', '');
          if (sshKeyPath) {
            env.HA_SSH_KEY_PATH = sshKeyPath;
          }

          const sshPassword = await context.secrets.get('haSshPassword');
          if (sshPassword) {
            env.HA_SSH_PASSWORD = sshPassword;
          }
        }

        const version: string =
          context.extension.packageJSON.version ?? '1.1.0';

        return [
          new vscode.McpStdioServerDefinition(
            'Home Assistant',
            'npx',
            ['--yes', '@jarahkon/hass-mcp-server'],
            env,
            version,
          ),
        ];
      },
    }),
  );
}
