import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch, { File, FormData } from "node-fetch";
dotenv.config();



if (!process.env.DIFY_API_URL) throw new Error("DIFY API URL is required.");
function generateId() {
  let result = "";
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 29; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}
const app = express();
// Base64 images exceed body-parser's default 100 KB limit.
app.use(bodyParser.json({ limit: process.env.MAX_REQUEST_SIZE || '50mb' }));
const botType = process.env.BOT_TYPE || 'Chat';
const inputVariable = process.env.INPUT_VARIABLE || '';
const outputVariable = process.env.OUTPUT_VARIABLE || '';
const difyApiUrl = process.env.DIFY_API_URL.replace(/\/+$/, '');

function invalidRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function parseMessage(message) {
  if (!message || typeof message.role !== 'string') {
    throw invalidRequest('Each message must have a role.');
  }
  if (typeof message.content === 'string') {
    return { role: message.role, text: message.content, images: [] };
  }
  if (message.content == null) {
    return { role: message.role, text: '', images: [] };
  }
  if (!Array.isArray(message.content)) {
    throw invalidRequest('Message content must be a string or an array of content parts.');
  }
  const text = [];
  const images = [];
  for (const part of message.content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      text.push(part.text);
    } else if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const url = part.image_url.url;
      if (url.startsWith('data:')) {
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
        if (!match || match[2].length % 4 === 1) {
          throw invalidRequest('Invalid Base64 image data URL.');
        }
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
          throw invalidRequest('Invalid Base64 image data URL.');
        }
        images.push({ bytes, mime: match[1].toLowerCase() });
      } else {
        let parsed;
        try { parsed = new URL(url); } catch { throw invalidRequest('Invalid image URL.'); }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw invalidRequest('Image URLs must use HTTP, HTTPS, or a Base64 image data URL.');
        }
        images.push({ url });
      }
    } else {
      throw invalidRequest('Unsupported or malformed message content part.');
    }
  }
  return { role: message.role, text: text.join('\n'), images };
}

async function toDifyFile(image, authorization, user) {
  if (image.url) {
    return { type: 'image', transfer_method: 'remote_url', url: image.url };
  }
  const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime.split('/')[1].replace('+xml', '');
  const form = new FormData();
  form.set('user', user);
  form.set('file', new File([image.bytes], `image.${extension}`, { type: image.mime }));
  const response = await fetch(`${difyApiUrl}/files/upload`, {
    method: 'POST',
    headers: { Authorization: authorization },
    body: form,
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Dify image upload failed (HTTP ${response.status}).`), { status: response.status });
  }
  const uploaded = await response.json();
  if (typeof uploaded.id !== 'string' || !uploaded.id) {
    throw Object.assign(new Error('Dify image upload returned no file ID.'), { status: 502 });
  }
  return { type: 'image', transfer_method: 'local_file', upload_file_id: uploaded.id };
}

let apiPath;
switch (botType) {
  case 'Chat':
    apiPath = '/chat-messages';
    break;
  case 'Completion':
    apiPath = '/completion-messages';
    break;
  case 'Workflow':
    apiPath = '/workflows/run';
    break;
  default:
    throw new Error('Invalid bot type in the environment variable.');
}
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization",
  "Access-Control-Max-Age": "86400",
};

app.use((req, res, next) => {
  res.set(corsHeaders);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  console.log('Request Method:', req.method); 
  console.log('Request Path:', req.path);
  next();
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>DIFY2OPENAI</title>
      </head>
      <body>
        <h1>Dify2OpenAI</h1>
        <p>Congratulations! Your project has been successfully deployed.</p>
      </body>
    </html>
  `);
});

app.get('/v1/models', (req, res) => {
  const models = {
    "object": "list",
    "data": [
      {
        "id": process.env.MODELS_NAME || "dify",
        "object": "model",
        "owned_by": "dify",
        "permission": null,
      }
    ]
  };
  res.json(models);
});

app.post("/v1/chat/completions", async (req, res) => {
  const authHeader =
    req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader) {
    return res.status(401).json({
      code: 401,
      errmsg: "Unauthorized.",
    });
  } else {
    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({
        code: 401,
        errmsg: "Unauthorized.",
      });
    }
  }
  try {
    const data = req.body;
    if (!Array.isArray(data.messages) || data.messages.length === 0) {
      throw invalidRequest('messages must be a non-empty array.');
    }
    const messages = data.messages.map(parseMessage);
    const user = data.user ?? 'apiuser';
    if (typeof user !== 'string' || !user.trim()) {
      throw invalidRequest('user must be a non-empty string.');
    }
    let queryString;
    if (botType === 'Chat') {
      const lastMessage = messages[messages.length - 1];
      queryString = `here is our talk history:\n'''\n${messages
        .slice(0, -1) 
        .map((message) => `${message.role}: ${message.text}`)
        .join('\n')}\n'''\n\nhere is my question:\n${lastMessage.text}`;
    } else if (botType === 'Completion' || botType === 'Workflow') {
      queryString = messages[messages.length - 1].text;
    }
    const stream = data.stream !== undefined ? data.stream : false;
    let requestBody;
    if (inputVariable) {
      requestBody = {
        inputs: { [inputVariable]: queryString },
        response_mode: "streaming",
        conversation_id: "",
        user,
        auto_generate_name: false
      };
    } else {
      requestBody = {
        "inputs": {},
        query: queryString,
        response_mode: "streaming",
        conversation_id: "",
        user,
        auto_generate_name: false
      };
    }
    // Chat history is replayed on every request, so include its images too.
    const selectedMessages = botType === 'Chat' ? messages : messages.slice(-1);
    const files = [];
    for (const message of selectedMessages) {
      for (const image of message.images) {
        files.push(await toDifyFile(image, authHeader, user));
      }
    }
    if (files.length) requestBody.files = files;
    // Dify Chat requires query even when custom input variables are configured.
    if (botType === 'Chat') requestBody.query = queryString;
    const resp = await fetch(difyApiUrl + apiPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authHeader.split(" ")[1]}`,
      },
      body: JSON.stringify(requestBody),
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: { message: `Dify request failed (HTTP ${resp.status}).` } });
    }

    let isResponseEnded = false;

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      const stream = resp.body;
      let buffer = "";
      let isFirstChunk = true;

      stream.on("data", (chunk) => {

        buffer += chunk.toString();
        let lines = buffer.split("\n");

        for (let i = 0; i < lines.length - 1; i++) {
          let line = lines[i].trim();

          if (!line.startsWith("data:")) continue;
          line = line.slice(5).trim();
          let chunkObj;
          try {
            if (line.startsWith("{")) {
              chunkObj = JSON.parse(line);
            } else {
              continue;
            }
          } catch (error) {
            console.error("Error parsing chunk:", error);
            continue;
          }

          if (chunkObj.event === "message" || chunkObj.event === "agent_message" || chunkObj.event === "text_chunk") {
            let chunkContent;
            if (chunkObj.event === "text_chunk") {
              chunkContent = chunkObj.data.text;
            } else {
              chunkContent = chunkObj.answer;
            }
    
            if (isFirstChunk) {
              chunkContent = chunkContent.trimStart();
              isFirstChunk = false;
            }
            if (chunkContent !== "") {
              const chunkId = `chatcmpl-${Date.now()}`;
              const chunkCreated = chunkObj.created_at;
              
              if (!isResponseEnded) {
              res.write(
                "data: " +
                  JSON.stringify({
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: chunkCreated,
                    model: data.model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: chunkContent,
                        },
                        finish_reason: null,
                      },
                    ],
                  }) +
                  "\n\n"
              );
            }
          } } else if (chunkObj.event === "workflow_finished" || chunkObj.event === "message_end") {
            const chunkId = `chatcmpl-${Date.now()}`;
            const chunkCreated = chunkObj.created_at;
            if (!isResponseEnded) {
            res.write(
              "data: " +
                JSON.stringify({
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created: chunkCreated,
                  model: data.model,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: "stop",
                    },
                  ],
                }) +
                "\n\n"
            );
          }
          if (!isResponseEnded) {
            res.write("data: [DONE]\n\n");
          }

            res.end();
            isResponseEnded = true;
          } else if (chunkObj.event === "agent_thought") {
          } else if (chunkObj.event === "ping") {
          } else if (chunkObj.event === "error") {
            console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
            res
              .status(500)
              .write(
                `data: ${JSON.stringify({ error: chunkObj.message })}\n\n`
              );
              
            if (!isResponseEnded) {
            res.write("data: [DONE]\n\n");
            }

            res.end();
            isResponseEnded = true;
          }
        }

        buffer = lines[lines.length - 1];
      });
    } else {
      let result = "";
      let usageData = "";
      let hasError = false;
      let messageEnded = false;
      let buffer = "";
      let skipWorkflowFinished = false;


      const stream = resp.body;
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split("\n");

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line === "") continue;
          let chunkObj;
          try {
            const cleanedLine = line.replace(/^data: /, "").trim();
            if (cleanedLine.startsWith("{") && cleanedLine.endsWith("}")) {
              chunkObj = JSON.parse(cleanedLine);
            } else {
              continue;
            }
          } catch (error) {
            console.error("Error parsing JSON:", error);
            continue;
          }

          if (
            chunkObj.event === "message" ||
            chunkObj.event === "agent_message"
          ) {
            result += chunkObj.answer;
            skipWorkflowFinished = true;
          } else if (chunkObj.event === "message_end") {
            messageEnded = true;
            usageData = {
              prompt_tokens: chunkObj.metadata.usage.prompt_tokens || 100,
              completion_tokens:
                chunkObj.metadata.usage.completion_tokens || 10,
              total_tokens: chunkObj.metadata.usage.total_tokens || 110,
            };
          } else if (chunkObj.event === "workflow_finished" && !skipWorkflowFinished) {
            messageEnded = true;
            const outputs = chunkObj.data.outputs;
            if (outputVariable) {
              result = outputs[outputVariable];
            } else {
              result = outputs;
            }
            result = String(result);
            usageData = {
              prompt_tokens: chunkObj.metadata?.usage?.prompt_tokens || 100,
              completion_tokens: chunkObj.metadata?.usage?.completion_tokens || 10,
              total_tokens: chunkObj.data.total_tokens || 110,
            };
          } else if (chunkObj.event === "agent_thought") {
          } else if (chunkObj.event === "ping") {
          } else if (chunkObj.event === "error") {
            console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
            hasError = true;
            break;
          } 
        }

        buffer = lines[lines.length - 1];
      });

      stream.on("end", () => {
        if (hasError) {
          res
            .status(500)
            .json({ error: "An error occurred while processing the request." });
        } else if (messageEnded) {
          const formattedResponse = {
            id: `chatcmpl-${generateId()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: data.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: result.trim(),
                },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
            usage: usageData,
            system_fingerprint: "fp_2f57f81c11",
          };
          const jsonResponse = JSON.stringify(formattedResponse, null, 2);
          res.set("Content-Type", "application/json");
          res.send(jsonResponse);
        } else {
          res.status(500).json({ error: "Unexpected end of stream." });
        }
      });
    }
  } catch (error) {
    console.error("Error:", error.message);
    if (!res.headersSent) {
      res.status(error.status || 500).json({ error: { message: error.message } });
    } else {
      res.end();
    }
  }
});

app.listen(process.env.PORT || 3000);
