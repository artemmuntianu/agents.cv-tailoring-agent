// AKS cluster for the CV tailoring platform.
//
// Helm cannot create node pools, so the cluster shape from the architecture doc
// (a small always-on system pool + a 0..N autoscaling user-workload pool) is
// described here. Deploy with:
//
//   az group create -n rg-cvtailoring -l westeurope
//   az deployment group create -g rg-cvtailoring -f deploy/infra/aks.bicep \
//     -p clusterName=cvtailoring systemNodeCount=1 userMinCount=0 userMaxCount=5
//
// Then install the platform chart (see docs/RUNBOOK.md).

@description('AKS cluster name')
param clusterName string = 'cvtailoring'

@description('Azure region')
param location string = resourceGroup().location

@description('Kubernetes version')
param kubernetesVersion string = '1.30'

@description('Small, always-on node pool for RabbitMQ / KEDA / ingress')
param systemNodeSize string = 'Standard_B2s' // 2 vCPU, 4 GB per the design doc
param systemNodeCount int = 1

@description('Dynamic pool for AI worker pods, autoscaled 0..N')
param userNodeSize string = 'Standard_D2s_v5'
param userMinCount int = 0
param userMaxCount int = 5

@description('Prefix for the container registry used by the worker image')
param acrName string = 'cvtailoringacr'

var systemPoolName = 'system'
var userPoolName = 'workload'

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource aks 'Microsoft.ContainerService/managedClusters@2024-02-01' = {
  name: clusterName
  location: location
  identity: { type: 'SystemAssigned' }
  sku: { name: 'Base', tier: 'Free' } // Free tier: no SLA charge for the control plane
  properties: {
    kubernetesVersion: kubernetesVersion
    dnsPrefix: clusterName
    enableRBAC: true
    agentPoolProfiles: [
      {
        name: systemPoolName
        mode: 'System'
        vmSize: systemNodeSize
        count: systemNodeCount
        enableAutoScaling: false
        osType: 'Linux'
        osDiskSizeGB: 30
        nodeLabels: { nodepool: 'system' }
        nodeTaints: [ 'workload=system:NoSchedule' ]
      }
      {
        name: userPoolName
        mode: 'User'
        vmSize: userNodeSize
        minCount: userMinCount
        maxCount: userMaxCount
        count: 1 // Cluster Autoscaler moves this between minCount (0) and maxCount
        enableAutoScaling: true
        osType: 'Linux'
        osDiskSizeGB: 40
        nodeLabels: { nodepool: 'workload' }
      }
    ]
    networkProfile: {
      networkPlugin: 'azure'
      loadBalancerSku: 'standard'
    }
    // Managed Prometheus: the metrics pipeline KEDA's HPAs rely on.
    azureMonitorProfile: {
      metrics: { enabled: true }
    }
  }
}

// Let the cluster pull the worker image without an imagePullSecret would require
// ACR pull RBAC; the simplest bootstrap is `az aks update --attach-acr`, run by
// the deploy script. We still export the ACR login server for convenience.
output acrLoginServer string = acr.properties.loginServer
output clusterName string = aks.name
output workerNodePool string = userPoolName
