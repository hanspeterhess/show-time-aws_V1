# analysis-server/Dockerfile.as

# Use an official Python runtime as a parent image
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

# Set the working directory in the container
WORKDIR /app

# Install Python and pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip, setuptools, and wheel
RUN python3.11 -m pip install --upgrade pip setuptools wheel

# Set python3.11 as the default python
RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/pip pip /usr/bin/pip3 1

# Copy the requirements file and install dependencies
COPY requirements.txt .
RUN /usr/bin/python3.11 -m pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# ENV nnUNet_raw="/tmp/nnunet_raw_placeholder"
# ENV nnUNet_preprocessed="/tmp/nnunet_preprocessed_placeholder"
# ENV nnUNet_results="/tmp/nnunet_results_placeholder"

# Command to run the application
CMD ["python", "blur_image.py"]
