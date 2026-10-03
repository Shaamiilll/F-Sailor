import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as whatsapp from "../services/whatsapp.service";
import * as subscriptions from "../services/subscription.service";
import { aiEnabled } from "../services/ai-reply.service";

/** Config, automation settings and usage for the signed-in factory. */
export async function getConfig(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const [config, usage, channels] = await Promise.all([
      whatsapp.getConfig(factoryId),
      whatsapp.getUsage(factoryId),
      subscriptions.listChannels(factoryId),
    ]);

    const channelEnabled = channels.some(
      (c) => c.channel === "whatsapp" && c.enabled
    );

    res.json({
      config,
      usage,
      // The plan gates the channel; surfacing it here lets the page explain why
      // automation is off rather than silently doing nothing.
      channelEnabled,
      aiAvailable: aiEnabled,
    });
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function updateConfig(req: AuthRequest, res: Response) {
  try {
    const config = await whatsapp.updateConfig(req.user!.factoryId!, req.body ?? {});
    res.json(config);
  } catch (err) {
    fail(res, err as Error);
  }
}

/** Checks the stored credentials against Meta and records the result. */
export async function verify(req: AuthRequest, res: Response) {
  try {
    res.json(await whatsapp.verifyConnection(req.user!.factoryId!));
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function disconnect(req: AuthRequest, res: Response) {
  try {
    res.json(await whatsapp.disconnect(req.user!.factoryId!));
  } catch (err) {
    fail(res, err as Error);
  }
}

/** Sends a one-off message, so a factory can prove the setup works. */
export async function sendTest(req: AuthRequest, res: Response) {
  try {
    const to = String(req.body?.to ?? "").replace(/[^\d]/g, "");
    if (!to) {
      res.status(400).json({
        error: "Enter the destination number in international format, e.g. 8613800138000",
      });
      return;
    }

    const text =
      String(req.body?.message ?? "").trim() ||
      "This is a test message from your KayanFlow WhatsApp automation. If you can read this, your connection works.";

    const messageId = await whatsapp.sendText(req.user!.factoryId!, to, text);
    res.json({ sent: true, messageId });
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function setHandover(req: AuthRequest, res: Response) {
  try {
    await whatsapp.setHandover(
      req.user!.factoryId!,
      String(req.params.id),
      Boolean(req.body?.handover)
    );
    res.json({ success: true });
  } catch (err) {
    fail(res, err as Error);
  }
}

// --- Meta webhook ------------------------------------------------------------

/**
 * Meta's subscription handshake. It calls this once when the webhook is saved
 * and expects `hub.challenge` echoed back as plain text.
 */
export async function verifyWebhook(req: Request, res: Response) {
  try {
    const challenge = await whatsapp.verifyWebhookSubscription(
      String(req.query["hub.mode"] ?? ""),
      String(req.query["hub.verify_token"] ?? ""),
      String(req.query["hub.challenge"] ?? "")
    );

    if (challenge === null) {
      res.status(403).send("Verification failed");
      return;
    }
    res.status(200).send(challenge);
  } catch (err) {
    console.error("[whatsapp] Webhook verification error:", err);
    res.status(500).send("error");
  }
}

/**
 * Inbound messages.
 *
 * Meta expects a 200 within seconds and redelivers anything slower, so the
 * response is sent first and the work happens after. Message ids are claimed in
 * the database, which is what stops a redelivery becoming a second reply.
 */
export async function receiveWebhook(req: Request, res: Response) {
  const rawBody = req.body as Buffer;

  const valid = await whatsapp
    .isValidSignature(rawBody, req.header("x-hub-signature-256"))
    .catch(() => false);

  if (!valid) {
    console.warn("[whatsapp] Rejected a webhook with an invalid signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Malformed payload" });
    return;
  }

  // Acknowledge before processing: generating a reply involves a model call and
  // an outbound send, both far slower than Meta's timeout.
  res.status(200).json({ received: true });

  const messages = whatsapp.parseInboundMessages(payload);

  for (const message of messages) {
    whatsapp.handleInboundMessage(message).catch((err) => {
      console.error("[whatsapp] Failed to handle inbound message:", err);
    });
  }
}

function fail(res: Response, err: Error) {
  if (err instanceof whatsapp.WhatsAppError) {
    const status =
      err.code === "NOT_CONNECTED" ? 409 : err.code === "VALIDATION" ? 400 : 502;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  console.error("[whatsapp]", err);
  res.status(500).json({ error: err.message });
}
