import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { RESEARCH_SERVICE } from "../lib/agentgate-contract";

const http = httpRouter();

// Auth routes (template requirement, do not remove).
auth.addHttpRoutes(http);

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Discovery index: the list of services AgentGate exposes. */
export const listServices = httpAction(async () => {
  return new Response(
    JSON.stringify(
      {
        protocol: RESEARCH_SERVICE.protocol,
        services: [
          {
            id: RESEARCH_SERVICE.id,
            name: RESEARCH_SERVICE.name,
            version: RESEARCH_SERVICE.version,
            price: `${RESEARCH_SERVICE.payment.amount} ${RESEARCH_SERVICE.payment.currency}`,
            contractUrl: `/api/services/${RESEARCH_SERVICE.id}/contract`,
          },
        ],
      },
      null,
      2,
    ),
    { status: 200, headers: jsonHeaders },
  );
});

/** Full machine-readable service contract for the AI Research service. */
export const getServiceContract = httpAction(async () => {
  return new Response(JSON.stringify(RESEARCH_SERVICE, null, 2), {
    status: 200,
    headers: jsonHeaders,
  });
});

http.route({
  pathPrefix: "/api/services/",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: jsonHeaders })),
});

http.route({
  path: "/api/services",
  method: "GET",
  handler: listServices,
});

http.route({
  path: `/api/services/${RESEARCH_SERVICE.id}/contract`,
  method: "GET",
  handler: getServiceContract,
});

export default http;
