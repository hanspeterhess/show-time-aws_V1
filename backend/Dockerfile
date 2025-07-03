FROM node:18

WORKDIR /app
COPY . .

RUN corepack enable && corepack prepare yarn@4.6.0 --activate
RUN yarn install

# Expose the port (use same as in index.js)
EXPOSE 4000

CMD ["yarn", "node", "index.js"]
