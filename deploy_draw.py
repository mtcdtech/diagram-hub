import urllib.request
import json
import ssl
import sys
import subprocess

ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

base = "https://docker.server.mtcd.org"
token = "ptr_caKh16OVXC+3G4shu9s7TXtumDZY04R6wwaOYkq+Pls="
stack_id = 99

def get_stack():
    url = f"{base}/api/stacks/{stack_id}"
    req = urllib.request.Request(url, headers={"x-api-key": token})
    with urllib.request.urlopen(req, context=ssl_context) as r:
        return json.loads(r.read().decode())

def get_stack_file():
    return """services:
  drawio:
    image: jgraph/drawio:latest
    container_name: drawio
    restart: unless-stopped
    ports:
      - "3448:8080"
    volumes:
      - /volume1/docker/drawio:/data

  diagram-hub:
    image: ghcr.io/mtcdtech/diagram-hub:${IMAGE_TAG:-latest}
    container_name: diagram-hub
    restart: unless-stopped
    pull_policy: always
    ports:
      - "3449:3000"
    environment:
      - EDIT_PASSPHRASE=EXseaBWGVaY9Kv6XPQlG-9FMWEcJEbjV
      - DRAWIO_EMBED_URL=https://draw-edit.server.mtcd.org/
      - OIDC_ISSUER_URL=https://auth.server.mtcd.org/application/o/diagram-hub/
      - OIDC_CLIENT_ID=diagram-hub
      - OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
      - APP_URL=https://draw.server.mtcd.org
    volumes:
      - diagram_hub_data:/data

volumes:
  diagram_hub_data:
"""

def get_git_sha():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"]).decode().strip()
    except Exception:
        return "latest"


def update_stack():
    stack = get_stack()
    stack_file = get_stack_file()
    
    env = stack.get("Env", [])
    # Remove existing managed environment variables
    managed_keys = {"IMAGE_TAG", "OIDC_CLIENT_SECRET"}
    env = [e for e in env if e.get("name") not in managed_keys]
    
    env.append({"name": "IMAGE_TAG", "value": get_git_sha()})
    env.append({"name": "OIDC_CLIENT_SECRET", "value": "ak_diagram_hub_secret_very_secure_987654"})
    
    payload = {
        "StackFileContent": stack_file,
        "Env": env,
        "Prune": False,
        "PullImage": True
    }
    
    url = f"{base}/api/stacks/{stack_id}?endpointId={stack['EndpointId']}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "x-api-key": token,
            "Content-Type": "application/json"
        },
        method="PUT"
    )
    
    try:
        with urllib.request.urlopen(req, context=ssl_context) as r:
            print("Stack Redeployed Successfully!")
            print(r.read().decode())
    except urllib.error.HTTPError as e:
        print("Update Failed:", e.code)
        print(e.read().decode(errors="replace"))
        sys.exit(1)

if __name__ == "__main__":
    update_stack()
