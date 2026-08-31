FROM basicai/xtreme1-pcd-tools

# Keep the upstream runtime and its dependencies, but replace the application with
# the versioned source in this repository.  This makes rebuilds fast and avoids
# relying on a mutable container filesystem.
COPY pcd_tools /app/pcd_tools

WORKDIR /app/pcd_tools
ENTRYPOINT ["python", "app.py"]
EXPOSE 5000
