// Read-only account check. It never performs inference or prints credentials.
import { createDefaultApplication } from '../dist/application/create-default-application.js';

const application = await createDefaultApplication();
const providers = await application.listProviders();
const configured = new Map((await application.listProviderPortals())
  .map((record) => [record.connection.providerId, record]));

for (const providerId of configured.keys()) {
  await application.refreshProviderPortal(providerId).catch(() => undefined);
}

const refreshed = new Map((await application.listProviderPortals())
  .map((record) => [record.connection.providerId, record]));
const rows = providers.map((provider) => {
  const record = refreshed.get(provider.id);
  const wallet = record?.latest?.wallet;
  const displayed = wallet?.value?.displayBalance;
  return {
    provider: provider.displayName,
    site: record?.connection.siteUrl ?? '-',
    auth: record?.connection.auth.kind ?? '-',
    status: wallet?.status ?? 'not-configured',
    code: wallet?.code ?? '-',
    http: wallet?.httpStatus ?? '-',
    balance: displayed ? `${displayed.currency} ${displayed.amount}` :
      wallet?.value?.remainingQuota === null || wallet?.value?.remainingQuota === undefined ? '-' : `${wallet.value.remainingQuota} quota`,
  };
});

if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else console.table(rows);
