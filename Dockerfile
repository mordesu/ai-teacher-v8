FROM node:18-alpine
WORKDIR /app
COPY server.js math-verify.js latex-humanize.js index.html ./
EXPOSE 8081
CMD ["node", "server.js"]
