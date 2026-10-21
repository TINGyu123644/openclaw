import { describe, expect, it, vi } from "vitest";
import { createWorkerEnvironmentStore } from "../../gateway/worker-environments/store.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as operationAdmission from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL worker environment companion schema", () => {
  useMixedAgentPair("postgres", "postgres");

  it("rolls back refused first-use schema preparation and retries through the worker", async () => {
    const database = admit(() => openOpenClawStateDatabase());
    const relation = () =>
      admit(() =>
        database.db
          .prepare("SELECT to_regclass('worker_environment_session_attachments')::text AS relation")
          .get(),
      );
    expect(relation()).toEqual({ relation: null });

    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    using _ = vi
      .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementationOnce((admitRequest, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            throw new Error("companion schema commit refused");
          }
          admitRequest(request, grant);
        }, attachment),
      );
    await expect(createWorkerEnvironmentStore({ database })).rejects.toThrow(
      "companion schema commit refused",
    );
    expect(relation()).toEqual({ relation: null });

    let store = await createWorkerEnvironmentStore({ database });
    try {
      await store.createSessionAttachmentIntent(
        {
          environmentId: "companion-environment",
          providerId: "synthetic-provider",
          profileId: "synthetic-profile",
          profileSnapshot: { settings: {} },
          provisionOperationId: "companion-provision",
          sessionId: "companion-session",
          sessionKey: "agent:main:companion-session",
          agentId: "main",
        },
        () => {},
      );
      await store.close();
      store = await createWorkerEnvironmentStore({ database });
      expect(store.getSessionAttachmentRecord("companion-session")).toMatchObject({
        sessionId: "companion-session",
        sessionKey: "agent:main:companion-session",
        environmentId: "companion-environment",
        generation: 1,
        closedAtMs: null,
      });
    } finally {
      await store.close();
    }
  });
});
