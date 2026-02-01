# Supabase Installation and Uninstallation Diagrams

## Installation Process

### Installation Flow Diagram

```mermaid
sequenceDiagram
    participant Caller as Caller Side<br/>(CLI/Dashboard)
    participant SupabaseMgmt as Supabase<br/>Management API
    participant EdgeFunc as Edge Function<br/>(stripe-setup)
    participant SupabaseDB as Supabase Database
    participant StripeAPI as Stripe API

    Note over Caller,SupabaseDB: Installation Process

    rect rgb(220, 240, 255)
        Note over Caller: Caller-Side Operations
        Caller->>SupabaseMgmt: Validate project access
        SupabaseMgmt-->>Caller: Access confirmed

        Caller->>SupabaseDB: Create stripe schema
        SupabaseDB-->>Caller: Schema created

        Caller->>SupabaseDB: Set schema comment<br/>("installation:started")
        SupabaseDB-->>Caller: Comment set

        Caller->>SupabaseMgmt: Deploy edge function<br/>(stripe-setup)
        SupabaseMgmt-->>Caller: Function deployed

        Caller->>SupabaseMgmt: Deploy edge function<br/>(stripe-webhook)
        SupabaseMgmt-->>Caller: Function deployed

        Caller->>SupabaseMgmt: Deploy edge function<br/>(stripe-worker)
        SupabaseMgmt-->>Caller: Function deployed

        Caller->>SupabaseMgmt: Set secret<br/>(STRIPE_SECRET_KEY)
        SupabaseMgmt-->>Caller: Secret set

        Caller->>SupabaseMgmt: Set secret<br/>(MANAGEMENT_API_URL, optional)
        SupabaseMgmt-->>Caller: Secret set
    end

    rect rgb(255, 240, 220)
        Note over EdgeFunc: Edge Function Operations
        Caller->>EdgeFunc: POST /stripe-setup<br/>(with access token)

        EdgeFunc->>SupabaseMgmt: Validate access token
        SupabaseMgmt-->>EdgeFunc: Token valid

        EdgeFunc->>SupabaseDB: Run database migrations<br/>(create tables, functions, triggers)
        SupabaseDB-->>EdgeFunc: Migrations complete

        EdgeFunc->>SupabaseDB: Release advisory locks<br/>(pg_advisory_unlock_all)
        SupabaseDB-->>EdgeFunc: Locks released

        EdgeFunc->>StripeAPI: Create managed webhook<br/>(webhook URL)
        StripeAPI-->>EdgeFunc: Webhook created

        EdgeFunc-->>Caller: Installation success<br/>(webhook ID)
    end

    rect rgb(220, 240, 255)
        Note over Caller: Caller-Side Operations (continued)
        Caller->>SupabaseDB: Enable pg_cron extension
        SupabaseDB-->>Caller: Extension enabled

        Caller->>SupabaseDB: Enable pg_net extension
        SupabaseDB-->>Caller: Extension enabled

        Caller->>SupabaseDB: Enable pgmq extension
        SupabaseDB-->>Caller: Extension enabled

        Caller->>SupabaseDB: Create pgmq queue<br/>(stripe_sync_work)
        SupabaseDB-->>Caller: Queue created

        Caller->>SupabaseDB: Generate and store<br/>worker secret in vault
        SupabaseDB-->>Caller: Secret stored

        Caller->>SupabaseDB: Schedule pg_cron job<br/>(stripe-worker every 60s)
        SupabaseDB-->>Caller: Job scheduled

        Caller->>SupabaseDB: Set schema comment<br/>("installed")
        SupabaseDB-->>Caller: Installation complete
    end
```

### Installation Flowchart

```mermaid
flowchart TD
    Start([Start Installation]) --> ValidateProject

    subgraph CallerSide1[" Caller Side - Setup Phase "]
        ValidateProject[Validate Project Access<br/>via Management API]
        ValidateProject --> CreateSchema[Create stripe schema<br/>in Supabase DB]
        CreateSchema --> SetStarted[Set schema comment:<br/>'installation:started']
        SetStarted --> DeploySetup[Deploy edge function:<br/>stripe-setup]
        DeploySetup --> DeployWebhook[Deploy edge function:<br/>stripe-webhook]
        DeployWebhook --> DeployWorker[Deploy edge function:<br/>stripe-worker]
        DeployWorker --> SetStripeSecret[Set secret in Supabase:<br/>STRIPE_SECRET_KEY]
        SetStripeSecret --> SetMgmtUrl{MANAGEMENT_API_URL<br/>needed?}
        SetMgmtUrl -->|Yes| SetMgmtSecret[Set secret in Supabase:<br/>MANAGEMENT_API_URL]
        SetMgmtUrl -->|No| InvokeSetup
        SetMgmtSecret --> InvokeSetup[POST to stripe-setup<br/>edge function]
    end

    subgraph EdgeFunction[" Edge Function - stripe-setup "]
        InvokeSetup --> ValidateToken[Validate access token<br/>via Management API]
        ValidateToken --> RunMigrations[Run database migrations:<br/>tables, functions, triggers]
        RunMigrations --> ReleaseLocks[Release advisory locks:<br/>pg_advisory_unlock_all]
        ReleaseLocks --> CreateWebhook[Create Stripe webhook<br/>via Stripe API]
        CreateWebhook --> ReturnSuccess[Return success response<br/>with webhook ID]
    end

    subgraph CallerSide2[" Caller Side - Worker Setup "]
        ReturnSuccess --> EnableCron[Enable pg_cron extension]
        EnableCron --> EnableNet[Enable pg_net extension]
        EnableNet --> EnablePgmq[Enable pgmq extension]
        EnablePgmq --> CreateQueue[Create pgmq queue:<br/>stripe_sync_work]
        CreateQueue --> GenSecret[Generate unique worker secret]
        GenSecret --> StoreSecret[Store secret in vault:<br/>stripe_sync_worker_secret]
        StoreSecret --> ScheduleJob[Schedule pg_cron job:<br/>invoke stripe-worker every 60s]
        ScheduleJob --> SetInstalled[Set schema comment:<br/>'installed']
    end

    SetInstalled --> End([Installation Complete])

    style CallerSide1 fill:#e1f0ff
    style CallerSide2 fill:#e1f0ff
    style EdgeFunction fill:#fff0e1
```

## Uninstallation Process

### Uninstallation Flow Diagram

```mermaid
sequenceDiagram
    participant Caller as Caller Side<br/>(CLI/Dashboard)
    participant EdgeFunc as Edge Function<br/>(stripe-setup)
    participant StripeAPI as Stripe API
    participant SupabaseDB as Supabase Database
    participant SupabaseMgmt as Supabase<br/>Management API

    Note over Caller,SupabaseMgmt: Uninstallation Process

    rect rgb(220, 240, 255)
        Note over Caller: Caller-Side Operations
        Caller->>EdgeFunc: DELETE /stripe-setup<br/>(with access token)
    end

    rect rgb(255, 240, 220)
        Note over EdgeFunc: Edge Function Operations
        EdgeFunc->>SupabaseMgmt: Validate access token
        SupabaseMgmt-->>EdgeFunc: Token valid

        EdgeFunc->>StripeAPI: List managed webhooks
        StripeAPI-->>EdgeFunc: Webhook list

        loop For each webhook
            EdgeFunc->>StripeAPI: Delete webhook
            StripeAPI-->>EdgeFunc: Webhook deleted
        end

        EdgeFunc->>SupabaseDB: Unschedule pg_cron job<br/>(stripe-sync-worker)
        SupabaseDB-->>EdgeFunc: Job unscheduled

        EdgeFunc->>SupabaseDB: Delete vault secret<br/>(stripe_sync_worker_secret)
        SupabaseDB-->>EdgeFunc: Secret deleted

        EdgeFunc->>SupabaseDB: Terminate active connections<br/>with locks on stripe schema
        SupabaseDB-->>EdgeFunc: Connections terminated

        EdgeFunc->>SupabaseDB: DROP SCHEMA stripe CASCADE<br/>(with retry logic)
        SupabaseDB-->>EdgeFunc: Schema dropped

        EdgeFunc->>SupabaseMgmt: Delete secret<br/>(STRIPE_SECRET_KEY)
        SupabaseMgmt-->>EdgeFunc: Secret deleted

        EdgeFunc->>SupabaseMgmt: Delete edge function<br/>(stripe-setup)
        SupabaseMgmt-->>EdgeFunc: Function deleted

        EdgeFunc->>SupabaseMgmt: Delete edge function<br/>(stripe-webhook)
        SupabaseMgmt-->>EdgeFunc: Function deleted

        EdgeFunc->>SupabaseMgmt: Delete edge function<br/>(stripe-worker)
        SupabaseMgmt-->>EdgeFunc: Function deleted

        EdgeFunc-->>Caller: Uninstallation success
    end

    rect rgb(220, 240, 255)
        Note over Caller: Caller-Side Operations (continued)
        Caller->>Caller: Process complete
    end
```

### Uninstallation Flowchart

```mermaid
flowchart TD
    Start([Start Uninstallation]) --> CallerInvoke

    subgraph CallerSide[" Caller Side "]
        CallerInvoke[DELETE to stripe-setup<br/>edge function with access token]
    end

    subgraph EdgeFunction[" Edge Function - stripe-setup "]
        CallerInvoke --> ValidateToken[Validate access token<br/>via Management API]
        ValidateToken --> ListWebhooks[List managed webhooks<br/>from Stripe API]

        ListWebhooks --> DeleteWebhooksLoop{More webhooks<br/>to delete?}
        DeleteWebhooksLoop -->|Yes| DeleteWebhook[Delete webhook<br/>via Stripe API]
        DeleteWebhook --> DeleteWebhooksLoop
        DeleteWebhooksLoop -->|No| UnscheduleJob

        UnscheduleJob[Unschedule pg_cron job:<br/>stripe-sync-worker]
        UnscheduleJob --> DeleteVaultSecret[Delete vault secret:<br/>stripe_sync_worker_secret]
        DeleteVaultSecret --> TerminateConns[Terminate active connections<br/>with locks on stripe schema]
        TerminateConns --> DropSchema[DROP SCHEMA stripe CASCADE]

        DropSchema --> RetryCheck{Schema dropped<br/>successfully?}
        RetryCheck -->|No, retry| WaitRetry[Wait 1 second]
        WaitRetry --> RetryAttempt{Max retries<br/>reached?}
        RetryAttempt -->|No| DropSchema
        RetryAttempt -->|Yes| ThrowError[Throw error]
        RetryCheck -->|Yes| DeleteStripeSecret

        DeleteStripeSecret[Delete secret in Supabase:<br/>STRIPE_SECRET_KEY]
        DeleteStripeSecret --> DeleteSetupFunc[Delete edge function:<br/>stripe-setup]
        DeleteSetupFunc --> DeleteWebhookFunc[Delete edge function:<br/>stripe-webhook]
        DeleteWebhookFunc --> DeleteWorkerFunc[Delete edge function:<br/>stripe-worker]
        DeleteWorkerFunc --> ReturnSuccess[Return success response]
    end

    subgraph CallerSide2[" Caller Side "]
        ReturnSuccess --> ProcessComplete[Process response]
    end

    ProcessComplete --> End([Uninstallation Complete])
    ThrowError --> ErrorEnd([Uninstallation Failed])

    style CallerSide fill:#e1f0ff
    style CallerSide2 fill:#e1f0ff
    style EdgeFunction fill:#fff0e1
```

## Key Boundaries

### Caller Side Responsibilities
- Validate project access
- Create initial database schema
- Deploy edge functions
- Set secrets (STRIPE_SECRET_KEY, MANAGEMENT_API_URL)
- Configure scheduled worker (pg_cron setup)
- Track installation status via schema comments

### Edge Function (stripe-setup) Responsibilities
- Validate access tokens via Management API
- Run database migrations (tables, functions, triggers)
- Manage Stripe webhooks (create/delete)
- Clean up database resources (drop schema, terminate connections)
- Delete secrets and edge functions during uninstall

### Security Notes
- All edge function invocations require access token validation
- Worker secret stored in Supabase vault for authentication
- Stripe secret key stored as Supabase secret, not in database
- Edge functions use internal database URL for privileged operations
