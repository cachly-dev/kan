import type { NextPageWithLayout } from "~/pages/_app";
import { getDashboardLayout } from "~/components/Dashboard";

/**
 * cachly: Glaeserne Fabrik als nativer Kan-Menuepunkt.
 * Die Fabrik ist der Flugschreiber des Beweisbetriebs (alle Gate-Urteile
 * als begehbare Zeitleiste); die UI kommt session-gesichert ueber
 * /api/mothership/fabrik (Proxy zu hookd).
 */
const FabrikPage: NextPageWithLayout = () => {
  return (
    <div className="h-full w-full">
      <iframe
        src="/api/mothership/fabrik"
        title="Glaeserne Fabrik"
        className="h-full w-full border-0"
      />
    </div>
  );
};

FabrikPage.getLayout = (page) => getDashboardLayout(page);

export default FabrikPage;