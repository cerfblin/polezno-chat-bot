FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node src ./src
COPY --chown=node:node data ./data
COPY --chown=node:node package.json ./
RUN mkdir /app/var && chown node:node /app/var
USER node
VOLUME ["/app/var"]
HEALTHCHECK --interval=30s --timeout=5s CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||3080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","src/main.ts"]
